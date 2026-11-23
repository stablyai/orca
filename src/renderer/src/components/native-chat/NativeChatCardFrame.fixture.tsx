import { Wrench } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import './appearance/native-chat-appearance.css'
import {
  NativeChatCardActions,
  NativeChatCardAvatar,
  NativeChatCardFrame,
  NativeChatCardStatus
} from './NativeChatCardFrame'

// The chat's text size setting at its smallest and largest.
const TEXT_SIZE = {
  small: '[--chat-font-size:12px] [--chat-ui-font-size:12px]',
  large: '[--chat-font-size:20px] [--chat-ui-font-size:20px]'
} as const

// The longest state and labels the cards can show, as a long translation would make them.
function Stress({ size }: { size: keyof typeof TEXT_SIZE }): React.JSX.Element {
  return (
    <div className={`native-chat-appearance space-y-3 p-4 ${TEXT_SIZE[size]}`}>
      <NativeChatCardFrame
        avatar={
          <NativeChatCardAvatar>
            <Wrench className="size-4 text-muted-foreground" aria-hidden />
          </NativeChatCardAvatar>
        }
        heading="Added a tool"
        status={
          <NativeChatCardStatus tone="muted">This app isn’t supported yet</NativeChatCardStatus>
        }
        trailing={<span>11:40 AM</span>}
        title="Notion workspace connector for the release team"
        footer={
          <NativeChatCardActions
            start={
              <Button type="button" variant="ghost" size="sm">
                Remove
              </Button>
            }
          >
            <Button type="button" size="sm">
              Open the sign-in page again
            </Button>
          </NativeChatCardActions>
        }
      >
        <p className="text-xs text-muted-foreground">mcp.notion.com</p>
      </NativeChatCardFrame>
      <NativeChatCardFrame
        avatar={
          <NativeChatCardAvatar>
            <Wrench className="size-4 text-muted-foreground" aria-hidden />
          </NativeChatCardAvatar>
        }
        heading="Composio"
        title="Have Composio call Atlas on New Outlook Message"
        footer={
          <NativeChatCardActions>
            <Button type="button" variant="outline" size="sm">
              I’ll do it in Composio myself
            </Button>
            <Button type="button" size="sm">
              Replace and set it up
            </Button>
          </NativeChatCardActions>
        }
      />
    </div>
  )
}

export const narrowSmallText = defineFixture({ width: 380, render: () => <Stress size="small" /> })

export const narrowLargeText = defineFixture({ width: 380, render: () => <Stress size="large" /> })

export const normalLargeText = defineFixture({ width: 640, render: () => <Stress size="large" /> })
