export function roomBlobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('room_file_read_failed'))
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      const separator = value.indexOf(',')
      if (separator < 0) {
        reject(new Error('room_file_read_failed'))
      } else {
        resolve(value.slice(separator + 1))
      }
    }
    reader.readAsDataURL(blob)
  })
}
