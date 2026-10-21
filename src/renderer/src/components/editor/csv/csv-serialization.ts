export function serializeCsvCell(value: string, delimiter: string, quoted = false): string {
  return quoted || /["\r\n]/.test(value) || value.includes(delimiter) || value.startsWith('\ufeff')
    ? `"${value.replaceAll('"', '""')}"`
    : value
}

export function serializeCsvRecord(
  values: readonly string[],
  delimiter: string,
  originalValues: readonly string[] = [],
  originalTokens: readonly string[] = []
): string {
  return values
    .map((value, index) => {
      const token = originalTokens[index]
      const quoteSingleField = values.length === 1 && (value === '' || /[,;\t]/.test(value))
      const validToken =
        token !== undefined &&
        (token.startsWith('"') ? /^"(?:[^"]|"")*"$/.test(token) : !/["\r\n]/.test(token))
      if (
        value === originalValues[index] &&
        validToken &&
        !(quoteSingleField && !token?.startsWith('"'))
      ) {
        return token
      }
      return serializeCsvCell(value, delimiter, token?.startsWith('"') || quoteSingleField)
    })
    .join(delimiter)
}
