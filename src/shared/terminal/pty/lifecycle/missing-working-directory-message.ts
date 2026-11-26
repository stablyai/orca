const MISSING_WORKING_DIRECTORY = /^Working directory "([^"\r\n]+)" does not exist\./m

/** The folder a refused spawn names, from the text its host reports. */
export function readMissingWorkingDirectory(message: string): string | null {
  return MISSING_WORKING_DIRECTORY.exec(message)?.[1] ?? null
}
