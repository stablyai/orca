import { hostedIosNativeChatStateExpression } from './hosted-ios-native-chat-cdp-expressions'
import { waitForHostedIosEvaluation } from './hosted-ios-webview-cdp'

export async function waitForHostedIosNativeChat(args: {
  discoveryUrl: string
  expectedText?: string
  expectedPlaceholder?: string
  timeoutMs: number
}): Promise<void> {
  await waitForHostedIosEvaluation(
    args.discoveryUrl,
    args.timeoutMs,
    hostedIosNativeChatStateExpression(args.expectedText, args.expectedPlaceholder),
    (value) => value === 'visible'
  )
}
