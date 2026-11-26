const FILE_TYPE = /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/i
export const isSlackMessageRef = (value: string): boolean =>
  /^slack:[A-Z0-9]+:[A-Z0-9]+:\d+\.\d+:\d+\.\d+$/.test(value)
export const isConnectorFileId = (value: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(value)
export const isConnectorFileType = (value: string | undefined): boolean =>
  value !== undefined && FILE_TYPE.test(value)
export const isImageFileType = (value: string | undefined): boolean =>
  isConnectorFileType(value) && value.toLowerCase().startsWith('image/')
