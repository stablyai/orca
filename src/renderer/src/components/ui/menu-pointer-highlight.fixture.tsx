import { defineFixture } from '../../component-fixtures/component-fixture'
import * as Dropdown from './dropdown-menu'
import * as Context from './context-menu'

function MenuPointerFixture({ kind }: { kind: 'dropdown' | 'context' }) {
  const Menu = kind === 'dropdown' ? Dropdown.DropdownMenu : Context.ContextMenu
  const Trigger = kind === 'dropdown' ? Dropdown.DropdownMenuTrigger : Context.ContextMenuTrigger
  const Content = kind === 'dropdown' ? Dropdown.DropdownMenuContent : Context.ContextMenuContent
  const Item = kind === 'dropdown' ? Dropdown.DropdownMenuItem : Context.ContextMenuItem
  const Sub = kind === 'dropdown' ? Dropdown.DropdownMenuSub : Context.ContextMenuSub
  const SubTrigger =
    kind === 'dropdown' ? Dropdown.DropdownMenuSubTrigger : Context.ContextMenuSubTrigger
  const SubContent =
    kind === 'dropdown' ? Dropdown.DropdownMenuSubContent : Context.ContextMenuSubContent

  return (
    <Menu modal={false}>
      <Trigger>Open menu</Trigger>
      <Content className="max-h-60 w-64">
        {['First', 'Second'].map((name) => (
          <Sub key={name}>
            <SubTrigger>{name}</SubTrigger>
            <SubContent>
              <Item>{name} child</Item>
              {Array.from({ length: 6 }, (_, index) => (
                <Item key={index}>
                  {name} option {index + 1}
                </Item>
              ))}
            </SubContent>
          </Sub>
        ))}
        {Array.from({ length: 40 }, (_, index) => (
          <Item key={index}>Row {index + 1}</Item>
        ))}
      </Content>
    </Menu>
  )
}

export const dropdown = defineFixture({
  width: 800,
  render: () => <MenuPointerFixture kind="dropdown" />
})

export const context = defineFixture({
  width: 800,
  render: () => <MenuPointerFixture kind="context" />
})
