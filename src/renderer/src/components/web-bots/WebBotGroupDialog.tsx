import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  createWebBotGroup,
  updateWebBotGroup,
  type AccountKey,
  type AccountRecord,
  type ExternalAgentRecord,
  type GroupChatRecord,
  type GroupMemberRole,
  type GroupSharedSkill,
  type GroupWorkflowMode,
  type WebBotsSnapshot
} from '@/web/tauri-native-web-bots'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingGroup: GroupChatRecord | null
  accounts: AccountRecord[]
  externalAgents: ExternalAgentRecord[]
  onUpdated: (snapshot: WebBotsSnapshot) => void
}

function keyId(key: AccountKey): string {
  return `${key.providerId}:${key.uuid}`
}

export function WebBotGroupDialog({
  open,
  onOpenChange,
  editingGroup,
  accounts,
  externalAgents,
  onUpdated
}: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [workflowMode, setWorkflowMode] = useState<GroupWorkflowMode>('parallel')
  const [maxRelayHops, setMaxRelayHops] = useState('3')
  const [sharedContext, setSharedContext] = useState('')
  const [rolesByKey, setRolesByKey] = useState<Record<string, string>>({})
  const [skills, setSkills] = useState<GroupSharedSkill[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const candidates = useMemo(() => {
    const web = accounts.map((a) => ({
      key: { providerId: a.providerId, uuid: a.uuid } satisfies AccountKey,
      label: a.alias,
      tag: a.providerId
    }))
    const ext = externalAgents.map((e) => ({
      key: {
        providerId: e.kind === 'openai_api' ? 'api' : 'cli',
        uuid: e.id
      } satisfies AccountKey,
      label: e.name,
      tag: e.kind === 'openai_api' ? 'API' : 'CLI'
    }))
    return [...web, ...ext]
  }, [accounts, externalAgents])

  useEffect(() => {
    if (!open) {
      return
    }
    setName(editingGroup?.name ?? '')
    setSelectedKeys(editingGroup ? editingGroup.members.map(keyId) : [])
    setWorkflowMode(editingGroup?.workflowMode ?? 'parallel')
    setMaxRelayHops(String(editingGroup?.maxRelayHops ?? 3))
    setSharedContext(editingGroup?.sharedContext ?? '')
    const roleMap: Record<string, string> = {}
    for (const item of editingGroup?.memberRoles ?? []) {
      roleMap[keyId(item.member)] = item.role
    }
    setRolesByKey(roleMap)
    setSkills(editingGroup?.sharedSkills ?? [])
    setError(null)
  }, [open, editingGroup])

  const toggleMember = (id: string) => {
    setSelectedKeys((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  const addSkill = () => {
    setSkills((prev) => [
      ...prev,
      {
        id: `skill-${Date.now()}-${prev.length}`,
        name: `技能 #${prev.length + 1}`,
        description: '',
        content: '',
        enabled: true
      }
    ])
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const members: AccountKey[] = selectedKeys
      .map((id) => candidates.find((c) => keyId(c.key) === id)?.key)
      .filter((k): k is AccountKey => Boolean(k))
    if (!name.trim()) {
      setError('请输入群聊名称')
      return
    }
    if (members.length === 0) {
      setError('请至少选择一个群聊成员')
      return
    }
    const memberRoles: GroupMemberRole[] = members
      .map((m) => ({ member: m, role: (rolesByKey[keyId(m)] ?? '').trim() }))
      .filter((r) => r.role.length > 0)
    const hops = Math.max(1, Math.min(6, Number.parseInt(maxRelayHops, 10) || 3))

    setSaving(true)
    setError(null)
    try {
      const snapshot = editingGroup
        ? await updateWebBotGroup({
            groupId: editingGroup.id,
            name: name.trim(),
            members,
            workflowMode,
            maxRelayHops: hops,
            sharedContext: sharedContext.trim() || null,
            sharedSkills: skills.filter((s) => s.name.trim() && s.content.trim()),
            memberRoles
          })
        : await createWebBotGroup({
            name: name.trim(),
            members,
            workflowMode,
            maxRelayHops: hops,
            sharedContext: sharedContext.trim() || null,
            sharedSkills: skills.filter((s) => s.name.trim() && s.content.trim()),
            memberRoles
          })
      onUpdated(snapshot)
      onOpenChange(false)
      toast.success(editingGroup ? '群聊配置已更新' : '群聊已创建')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="list" scrollable busy={saving}>
        <DialogHeader>
          <DialogTitle>
            {editingGroup ? `编辑群聊 · ${editingGroup.name}` : '新建多账号群聊'}
          </DialogTitle>
          <DialogDescription>
            混合编排网页 Bot 与外部 API/CLI Agent，支持并行讨论、评审流和 A2A 接力。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-name">群聊名称</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 架构评审组"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>协作模式</Label>
              <Select
                value={workflowMode}
                onValueChange={(v) => setWorkflowMode(v as GroupWorkflowMode)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="parallel">并行讨论</SelectItem>
                  <SelectItem value="review">顺序评审流</SelectItem>
                  <SelectItem value="a2a_relay">A2A @接力</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="relay-hops">最大接力跳数（1–6）</Label>
              <Input
                id="relay-hops"
                type="number"
                min={1}
                max={6}
                value={maxRelayHops}
                onChange={(e) => setMaxRelayHops(e.target.value)}
                disabled={workflowMode !== 'a2a_relay'}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>选择成员与角色设定</Label>
            {candidates.length === 0 ? (
              <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
                暂无可用账号或外部 Agent，请先添加成员。
              </p>
            ) : (
              <div className="flex max-h-48 flex-col gap-2 overflow-y-auto scrollbar-sleek rounded-md border border-border p-2">
                {candidates.map((cand) => {
                  const id = keyId(cand.key)
                  const checked = selectedKeys.includes(id)
                  return (
                    <div key={id} className="flex items-center gap-2">
                      <Checkbox
                        id={`member-${id}`}
                        checked={checked}
                        onCheckedChange={() => toggleMember(id)}
                      />
                      <Label
                        htmlFor={`member-${id}`}
                        className="min-w-28 cursor-pointer truncate text-xs font-medium"
                      >
                        {cand.label}
                        <span className="ml-1 text-muted-foreground">({cand.tag})</span>
                      </Label>
                      {checked ? (
                        <Input
                          value={rolesByKey[id] ?? ''}
                          onChange={(e) =>
                            setRolesByKey((prev) => ({ ...prev, [id]: e.target.value }))
                          }
                          placeholder="角色设定（可选）"
                          className="h-7 flex-1 text-xs"
                        />
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-context">共享上下文（可选）</Label>
            <Textarea
              id="group-context"
              rows={3}
              value={sharedContext}
              onChange={(e) => setSharedContext(e.target.value)}
              placeholder="每次群聊都会附带这段背景说明"
              className="text-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label>共享技能（Skills）</Label>
              <Button type="button" variant="outline" size="xs" onClick={addSkill}>
                <Plus className="size-3" />
                添加技能
              </Button>
            </div>
            {skills.map((skill, idx) => (
              <div
                key={skill.id}
                className="flex flex-col gap-1.5 rounded-md border border-border p-2"
              >
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={skill.enabled}
                    onCheckedChange={(v) =>
                      setSkills((prev) =>
                        prev.map((s, i) => (i === idx ? { ...s, enabled: v === true } : s))
                      )
                    }
                  />
                  <Input
                    value={skill.name}
                    onChange={(e) =>
                      setSkills((prev) =>
                        prev.map((s, i) => (i === idx ? { ...s, name: e.target.value } : s))
                      )
                    }
                    placeholder="技能名称"
                    className="h-7 flex-1 text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setSkills((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
                <Textarea
                  rows={2}
                  value={skill.content}
                  onChange={(e) =>
                    setSkills((prev) =>
                      prev.map((s, i) => (i === idx ? { ...s, content: e.target.value } : s))
                    )
                  }
                  placeholder="技能提示词内容"
                  className="text-xs"
                />
              </div>
            ))}
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {editingGroup ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
