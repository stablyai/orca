import rehypeRaw from 'rehype-raw'
import type { Pluggable } from 'unified'
import type { CommentMarkdownBlockPreparer } from '../../sidebar/CommentMarkdown'
import { NativeChatMarkdownImageOrigins } from './native-chat-markdown-image-origins'
import { prepareNativeChatMarkdown } from './native-chat-markdown-source-map'
import { NativeChatMarkdownImageOriginContext } from './native-chat-markdown-image-origin-context'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'

export const prepareNativeChatImageBlock: CommentMarkdownBlockPreparer = (input) => {
  const source = prepareNativeChatMarkdown(input.content, input.start, input.growing)
  const origins = new NativeChatMarkdownImageOrigins(source, input.content, input.start)
  return {
    props: {
      children: source.text,
      remarkPlugins: [
        origins.html.bind,
        origins.authoredImages,
        ...input.remarkPlugins.map<Pluggable>((plugin) =>
          plugin === remarkNativeChatFileDestinations
            ? [remarkNativeChatFileDestinations, { recordPreview: origins.recordPreview }]
            : plugin
        )
      ],
      remarkRehypeOptions: {
        ...input.remarkRehypeOptions,
        handlers: { ...input.remarkRehypeOptions?.handlers, html: origins.htmlHandler }
      },
      rehypePlugins: input.rehypePlugins.map<Pluggable>((plugin) =>
        plugin === rehypeRaw ? [rehypeRaw, { onRawImage: origins.rawImage }] : plugin
      )
    },
    afterRehypePlugins: [origins.finalize],
    wrap: (element) => (
      <NativeChatMarkdownImageOriginContext.Provider value={origins.finalNodes}>
        {element}
      </NativeChatMarkdownImageOriginContext.Provider>
    )
  }
}
