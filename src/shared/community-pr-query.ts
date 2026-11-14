export function communityQueryNumber(text: string | undefined): number | null {
  const match = text
    ?.trim()
    .match(/^(?:#|pr[\s:#]+#?|https:\/\/github\.com\/stablyai\/orca\/pull\/)?([1-9]\d{0,9})\/?$/i)
  const number = match ? Number(match[1]) : 0
  return number > 0 && number <= 2_147_483_647 ? number : null
}
