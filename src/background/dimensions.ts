// Pure box-fitting math for elements that cannot use CSS object-fit
// (the TikTok <iframe>). Same semantics as object-fit cover/contain/fill.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FitMode = 'cover' | 'contain' | 'fill';

export function fitBox(
  containerWidth: number,
  containerHeight: number,
  contentWidth: number,
  contentHeight: number,
  mode: FitMode,
): Box {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(0, containerWidth), height: Math.max(0, containerHeight) };
  }
  if (contentWidth <= 0 || contentHeight <= 0 || mode === 'fill') {
    return { x: 0, y: 0, width: containerWidth, height: containerHeight };
  }
  const scale =
    mode === 'cover'
      ? Math.max(containerWidth / contentWidth, containerHeight / contentHeight)
      : Math.min(containerWidth / contentWidth, containerHeight / contentHeight);
  const width = contentWidth * scale;
  const height = contentHeight * scale;
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  };
}
