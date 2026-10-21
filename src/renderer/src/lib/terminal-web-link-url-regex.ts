// Match the fallback extractor's BMP boundaries without treating astral emoji as terminators.
const nonAsciiBoundary = String.raw`(?!(?=[\u0080-\uffff])[\p{P}\p{S}\p{Z}])`

export const TERMINAL_WEB_LINK_URL_REGEX = new RegExp(
  String.raw`(https?|HTTPS?):[/]{2}(?:${nonAsciiBoundary}[^\s"'!*(){}|\\\^<>\x60])*${nonAsciiBoundary}[^\s"':,.!?{}|\\\^~\[\]\x60()<>]`,
  'u'
)
