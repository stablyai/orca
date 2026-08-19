type NativeObjectUrlApi = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>

export type BackgroundImageObjectUrlApi = {
  create: (data: Uint8Array, mimeType: string) => Promise<string | null>
  revoke: (objectUrl: string) => void
}

type BackgroundImageObjectUrlOptions = {
  objectUrls?: NativeObjectUrlApi
  decodeImage?: (objectUrl: string) => Promise<void>
}

function copyImageBytes(data: Uint8Array): ArrayBuffer {
  const bytes = new Uint8Array(data.byteLength)
  bytes.set(data)
  return bytes.buffer
}

export async function decodeBrowserBackgroundImage(objectUrl: string): Promise<void> {
  const image = new Image()
  image.src = objectUrl
  await image.decode()
}

export function createBackgroundImageObjectUrlApi(
  options: BackgroundImageObjectUrlOptions = {}
): BackgroundImageObjectUrlApi {
  const objectUrls = options.objectUrls ?? URL
  const decodeImage = options.decodeImage ?? decodeBrowserBackgroundImage

  return {
    async create(data, mimeType) {
      let objectUrl: string | null = null
      try {
        objectUrl = objectUrls.createObjectURL(new Blob([copyImageBytes(data)], { type: mimeType }))
        await decodeImage(objectUrl)
        return objectUrl
      } catch {
        if (objectUrl !== null) {
          objectUrls.revokeObjectURL(objectUrl)
        }
        return null
      }
    },
    revoke(objectUrl) {
      objectUrls.revokeObjectURL(objectUrl)
    }
  }
}

export const browserBackgroundImageObjectUrls = createBackgroundImageObjectUrlApi()
