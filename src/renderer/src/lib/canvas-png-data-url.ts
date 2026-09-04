export function canvasToPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  canvas.toBlob((blob) => {
    if (!blob) {
      try {
        resolve(canvas.toDataURL('image/png'))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('PNG canvas encoding failed'))
      }
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('PNG blob reading failed'))
    reader.readAsDataURL(blob)
  }, 'image/png')
  return promise
}
