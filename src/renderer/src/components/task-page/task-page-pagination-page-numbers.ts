export function getPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 9) {
    return Array.from({ length: total }, (_, i) => i)
  }
  const pages = new Set<number>()
  pages.add(0)
  pages.add(total - 1)
  for (let i = Math.max(0, current - 2); i <= Math.min(total - 1, current + 2); i++) {
    pages.add(i)
  }
  const sorted = [...pages].sort((a, b) => a - b)
  const result: (number | 'ellipsis')[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      result.push('ellipsis')
    }
    result.push(sorted[i])
  }
  return result
}
