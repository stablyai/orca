/** A comma-separated address list, commas inside quoted names kept: `"Lee, Sam" <s@x.com>, a@x.com`. */
export function splitAddresses(header: string | undefined): string[] {
  return (header?.match(/(?:"[^"]*"|[^,"])+/g) ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
