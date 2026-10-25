export function hasControllingTty(tty: string | undefined): tty is string {
  return (
    typeof tty === 'string' &&
    tty !== '' &&
    tty !== '?' &&
    tty !== '??' &&
    tty !== '-' &&
    tty !== '0' &&
    !/^0,\d+$/.test(tty)
  )
}
