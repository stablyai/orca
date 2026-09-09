type ExitProvenConnection = {
  close: () => Promise<boolean>
}

export async function cancelProcessAcquisition(input: {
  cancel: () => void
  connection: () => ExitProvenConnection | null
  exitProven: () => boolean
  finished: Promise<void>
}): Promise<boolean> {
  input.cancel()
  const connectionBeforeFinish = input.connection()
  if (connectionBeforeFinish) {
    if ((await connectionBeforeFinish.close()) !== true) {
      return false
    }
  }
  await input.finished
  if (input.exitProven()) {
    return true
  }
  const connectionAfterFinish = input.connection()
  if (!connectionAfterFinish || connectionAfterFinish === connectionBeforeFinish) {
    return true
  }
  return (await connectionAfterFinish.close()) === true
}
