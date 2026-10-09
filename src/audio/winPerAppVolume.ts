// Windows per-app volume fade (notify audio alert).
//
// TikTok's embed player only supports mute/unMute (no setVolume), so the only
// way to fade its sound in (instead of jumping to full volume) is to ramp the
// volume of the VS Code *audio session* at the OS level. That needs Windows
// Core Audio (IAudioSessionManager2 / ISimpleAudioVolume), driven via a C#
// COM-interop snippet.
//
// Design: a SINGLE persistent PowerShell process loads the C# once (Add-Type
// compiles slowly, ~1-2s). After that a ramp is just a stdin line — instant, so
// the fade is ready the moment the TikTok iframe starts producing sound. A
// one-shot process per notify would lag ~2s behind the unmute (full-volume
// burst before the fade catches it), defeating the purpose.
//
// macOS has no per-app volume API; Linux could use pactl later. This module is
// a no-op off Windows — callers must check isPerAppVolumeSupported() first.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type HelperProc = ChildProcessByStdio<Writable, Readable, null>;

// Validated COM interop: enumerates the default render endpoint's sessions and
// fades the one whose process name matches (VS Code renderers are all "Code*").
const CS_SOURCE = `
using System;
using System.Runtime.InteropServices;

public static class VibePerAppVolume
{
    enum EDataFlow { eRender = 0 }
    enum ERole { eMultimedia = 1 }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IntPtr devices);
        void GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        void GetAudioSessionControl(ref Guid sessionId, int streamFlags, out IntPtr sessionControl);
        void GetSimpleAudioVolume(ref Guid sessionId, int streamFlags, out IntPtr audioVolume);
        void GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        void GetCount(out int count);
        void GetSession(int index, out IAudioSessionControl session);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl
    {
        void GetState(out int state);
        void GetDisplayName(out IntPtr displayName);
        void SetDisplayName(IntPtr displayName, ref Guid eventContext);
        void GetIconPath(out IntPtr iconPath);
        void SetIconPath(IntPtr iconPath, ref Guid eventContext);
        void GetGroupingParam(out Guid groupingParam);
        void SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
        void RegisterAudioSessionNotification(IntPtr newNotifications);
        void UnregisterAudioSessionNotification(IntPtr newNotifications);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        void GetState(out int state);
        void GetDisplayName(out IntPtr displayName);
        void SetDisplayName(IntPtr displayName, ref Guid eventContext);
        void GetIconPath(out IntPtr iconPath);
        void SetIconPath(IntPtr iconPath, ref Guid eventContext);
        void GetGroupingParam(out Guid groupingParam);
        void SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
        void RegisterAudioSessionNotification(IntPtr newNotifications);
        void UnregisterAudioSessionNotification(IntPtr newNotifications);
        void GetSessionIdentifier(out IntPtr retVal);
        void GetSessionInstanceIdentifier(out IntPtr retVal);
        void GetProcessId(out uint retVal);
        void IsSystemSoundsSession();
        void SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        void SetMasterVolume(float level, ref Guid eventContext);
        void GetMasterVolume(out float level);
        void SetChannelVolume(uint channelCount, float[] levels, ref Guid eventContext);
        void GetChannelVolume(uint channelCount, out float[] levels);
        void SetMute(bool mute, ref Guid eventContext);
        void GetMute(out bool mute);
    }

    const int CLSCTX_ALL = 23;

    static string ProcessName(uint pid)
    {
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
        catch { return "?"; }
    }

    static void RampVolume(ISimpleAudioVolume vol, float target, float seconds)
    {
        Guid g = Guid.Empty;
        int steps = Math.Max(2, (int)(seconds * 40));
        vol.SetMasterVolume(0f, ref g);
        for (int s = 1; s <= steps; s++)
        {
            float level = target * (float)s / steps;
            vol.SetMasterVolume(level, ref g);
            System.Threading.Thread.Sleep(25);
        }
        vol.SetMasterVolume(target, ref g);
    }

    public static int RampMatching(string nameContains, float fadeSeconds, int pollTimeoutMs)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < pollTimeoutMs)
        {
            try
            {
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                IMMDevice device;
                enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
                Guid iidMgr = typeof(IAudioSessionManager2).GUID;
                object o; device.Activate(ref iidMgr, CLSCTX_ALL, IntPtr.Zero, out o);
                var mgr = (IAudioSessionManager2)o;
                IAudioSessionEnumerator sessionEnum; mgr.GetSessionEnumerator(out sessionEnum);
                int count; sessionEnum.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl ctrl; sessionEnum.GetSession(i, out ctrl);
                    var ctrl2 = (IAudioSessionControl2)ctrl;
                    uint pid; ctrl2.GetProcessId(out pid);
                    string name = ProcessName(pid);
                    if (name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        var vol = (ISimpleAudioVolume)ctrl;
                        float v; vol.GetMasterVolume(out v);
                        if (v <= 0f) v = 0.6f;
                        RampVolume(vol, v, fadeSeconds);
                        return 1;
                    }
                }
            }
            catch { }
            System.Threading.Thread.Sleep(25);
        }
        return 0;
    }
}
`;

let helper: HelperProc | null = null;
let starting: Promise<boolean> | null = null;
let stdoutBuf = '';
// FIFO of pending ramp resolvers (ramps are serialized by the helper's loop).
const pending: Array<(ran: number) => void> = [];

function buildScript(): string {
  return (
    `$ProgressPreference='SilentlyContinue'\n` +
    `Add-Type -TypeDefinition @'\n${CS_SOURCE}\n'@ -Language CSharp\n` +
    `[Console]::Out.WriteLine('READY')\n` +
    `while ($true) {\n` +
    `  $line = [Console]::In.ReadLine()\n` +
    `  if ($null -eq $line) { break }\n` +
    `  $p = $line -split ' '\n` +
    `  if ($p.Count -ge 4 -and $p[0] -eq 'RAMP') {\n` +
    `    $r = [VibePerAppVolume]::RampMatching($p[3], [float]$p[1], [int]$p[2])\n` +
    `    [Console]::Out.WriteLine('RESULT ' + $r)\n` +
    `  }\n` +
    `}`
  );
}

function handleLine(line: string): void {
  const t = line.trim();
  if (t === 'READY') {
    starting = Promise.resolve(true);
    return;
  }
  if (t.startsWith('RESULT')) {
    const n = parseInt(t.slice(6).trim(), 10) || 0;
    const resolver = pending.shift();
    if (resolver) resolver(n);
  }
}

function startHelper(): Promise<boolean> {
  if (helper) return Promise.resolve(true);
  if (starting) return starting;
  starting = new Promise<boolean>((resolve) => {
    const encoded = Buffer.from(buildScript(), 'utf16le').toString('base64');
    let proc: HelperProc;
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
      );
    } catch {
      resolve(false);
      return;
    }
    helper = proc;
    stdoutBuf = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        handleLine(stdoutBuf.slice(0, nl));
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
    });
    // First READY resolves the start promise; later READYs are no-ops.
    const onReady = (): void => resolve(true);
    proc.stdout.once('data', onReady);
    const fail = (): void => {
      helper = null;
      starting = null;
      for (const r of pending.splice(0)) r(0);
      resolve(false);
    };
    proc.on('error', fail);
    proc.on('close', fail);
  });
  return starting;
}

/** Per-app volume fade is only implemented for Windows right now. */
export function isPerAppVolumeSupported(): boolean {
  return process.platform === 'win32';
}

/** Pre-load the helper (compile the C#) so the first notify fade is instant. */
export function warmupPerAppVolume(): void {
  if (isPerAppVolumeSupported()) void startHelper();
}

/**
 * Gently fade in the VS Code app's audio (0 -> its current mixer level) over
 * `fadeSeconds`, waiting up to `pollTimeoutMs` for the session to appear (it
 * only exists once the TikTok iframe starts producing sound). Resolves to 1 if
 * a ramp ran, 0 if unsupported / no session appeared / helper failed.
 */
export function rampNotifyFade(
  fadeSeconds = 2.5,
  pollTimeoutMs = 1200,
  nameContains = 'code',
): Promise<number> {
  return new Promise((resolve) => {
    if (!isPerAppVolumeSupported()) {
      resolve(0);
      return;
    }
    void startHelper().then((ok) => {
      if (!ok || !helper) {
        resolve(0);
        return;
      }
      const name = nameContains.replace(/'/g, "''");
      const timer = setTimeout(() => {
        // Timed out (helper stuck / session never appeared): drop this request.
        const i = pending.indexOf(resolve as (ran: number) => void);
        if (i >= 0) pending.splice(i, 1);
        resolve(0);
      }, fadeSeconds * 1000 + pollTimeoutMs + 3000);
      (timer as { unref?: () => void }).unref?.();
      const wrapped = (ran: number): void => {
        clearTimeout(timer);
        resolve(ran);
      };
      pending.push(wrapped);
      helper.stdin.write(`RAMP ${fadeSeconds} ${pollTimeoutMs} ${name}\n`);
    });
  });
}

/** Kill the persistent helper (call on extension deactivate). */
export function disposePerAppVolume(): void {
  if (helper) {
    try {
      helper.stdin.end();
      helper.kill();
    } catch {
      /* already gone */
    }
  }
  helper = null;
  starting = null;
  for (const r of pending.splice(0)) r(0);
}
