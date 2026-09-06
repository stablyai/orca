export function terminalMarkerCommand(marker: string): string {
  const encoded = [...marker]
    .map((character) => `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`)
    .join('')
  return `printf '${encoded}\\n'`
}
