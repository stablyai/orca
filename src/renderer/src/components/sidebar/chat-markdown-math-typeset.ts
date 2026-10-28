import rehypeKatex from 'rehype-katex'

export const typesetChatMath = rehypeKatex({
  trust: false,
  maxSize: 20,
  maxExpand: 1000,
  strict: 'ignore'
})
