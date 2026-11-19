import { unified, type PluggableList } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { nativeChatVisualRemarkPlugins } from '../media/visuals/native-chat-visual-markdown-syntax'
import {
  commentMarkdownAllowedTagNames,
  commentMarkdownSanitizeSchema
} from '../../comment-markdown/comment-markdown-sanitize'
import { remarkUnknownHtmlAsText } from '../../comment-markdown/comment-markdown-unknown-html-as-text'
import { commentMarkdownRemarkPlugins } from '../../comment-markdown/comment-markdown-remark-plugins'
import { remarkChatMath } from '../../comment-markdown/chat-markdown-math'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'
import { remarkNativeChatHtmlTokenOrigins } from './native-chat-markdown-html-source-map'
import {
  NATIVE_CHAT_IMAGE_ORIGIN_PROPERTY,
  type NativeChatMarkdownImageOrigins
} from './native-chat-markdown-image-origins'

export function nativeChatMarkdownImageParser(
  visuals: boolean,
  origins?: NativeChatMarkdownImageOrigins,
  postSanitize: PluggableList = []
) {
  const parser = unified().use(remarkParse)
  if (origins) {
    parser.use(remarkNativeChatHtmlTokenOrigins).use(origins.html.bind).use(origins.authoredImages)
  }
  const result = parser
    .use(remarkUnknownHtmlAsText(commentMarkdownAllowedTagNames, origins?.html.rewrite))
    .use(commentMarkdownRemarkPlugins)
    .use(remarkChatMath)
    .use(visuals ? nativeChatVisualRemarkPlugins('image-source-discovery') : [])
    .use(remarkNativeChatFileDestinations, { recordPreview: origins?.recordPreview })
    .use(remarkRehype, {
      allowDangerousHtml: true,
      ...(origins ? { handlers: { html: origins.htmlHandler } } : {})
    })
    .use(rehypeRaw, origins ? { onRawImage: origins.rawImage } : undefined)
    .use(
      rehypeSanitize,
      origins
        ? {
            ...commentMarkdownSanitizeSchema,
            attributes: {
              ...commentMarkdownSanitizeSchema.attributes,
              img: [
                ...(commentMarkdownSanitizeSchema.attributes?.img ?? []),
                NATIVE_CHAT_IMAGE_ORIGIN_PROPERTY
              ]
            }
          }
        : commentMarkdownSanitizeSchema
    )
  result.use(postSanitize)
  if (origins) {
    result.use(origins.finalize)
  }
  return result
}
