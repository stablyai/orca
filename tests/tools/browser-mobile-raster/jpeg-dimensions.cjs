function jpegSize(bytes) {
  const b = Buffer.from(bytes)
  if (b[0] !== 255 || b[1] !== 216) {
    throw new Error('Not JPEG')
  }
  let p = 2
  while (p < b.length) {
    if (b[p] !== 255) {
      p++
      continue
    }
    while (b[p] === 255) {
      p++
    }
    const marker = b[p++]
    if (marker === 217 || marker === 218) {
      break
    }
    if (marker === 1 || (marker >= 208 && marker <= 215)) {
      continue
    }
    const length = b.readUInt16BE(p)
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      return { width: b.readUInt16BE(p + 5), height: b.readUInt16BE(p + 3) }
    }
    p += length
  }
  throw new Error('JPEG has no dimensions')
}

module.exports = { jpegSize }
