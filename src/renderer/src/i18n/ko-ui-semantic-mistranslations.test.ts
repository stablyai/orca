import fs from 'node:fs'

import { describe, expect, it } from 'vitest'
import ko from './locales/ko.json'

const correctedValues = {
  'auto.components.settings.AutoRenameBranchFromWorkSetting.d9b65054ef':
    ') 작업을 요약하는 짧은 이름으로 변경됩니다. Orca가 직접 이름 붙인 브랜치만 이름을 바꾸며, 푸시된 후에는 이름을 바꾸지 않습니다.',
  'auto.components.settings.source.control.action.recipe.options.commitMessage':
    '스테이징된 변경 사항에서 commit 메시지를 생성합니다.',
  'auto.components.settings.DevToolsPane.orcaCloudDescription':
    '자사 클라우드 로그인의 개발자 전용 미리보기. 프로덕션에서는 숨겨집니다. 개발 환경에서는 ORCA_CLOUD_API_URL과 ORCA_CLOUD_CLIENT_ID가 설정되면 사이드바 계정 전환기에도 표시됩니다.',
  'auto.components.settings.EphemeralVmsPane.whatTitle': '이 스킬로 함께 하는 작업',
  'auto.components.settings.EphemeralVmsPane.recipes': '레시피',
  'auto.components.right.sidebar.SourceControl.a5e5a11090':
    '모든 변경 사항 취소 실패 — 취소 전에 파일의 스테이징을 해제하지 못했습니다.',
  'auto.components.right.sidebar.SourceControl.6d7f2a47e5': '폴더의 변경 사항 취소',
  'auto.components.right.sidebar.source.control.discard.confirmation.40e9357b2a':
    '이렇게 하면 HEAD에서 파일을 복원하고 파일 삭제를 취소합니다. 이 작업은 취소할 수 없습니다.',
  'auto.components.right.sidebar.source.control.primary.action.5a477d80cb':
    '모든 변경 사항 스테이징',
  'auto.components.settings.DeveloperPermissionsPane.f903bf20b5':
    '터미널과 개발 도구가 로컬 네트워크의 서비스에 연결할 수 있도록 허용합니다. macOS는 이 권한의 현재 상태를 Orca에 보고하지 않습니다.',
  'auto.components.sidebar.AddRemoteHostDialog.sshImportSynced':
    '{{value0}} 호스트{{value1}}을(를) Orca에 추가했습니다.',
  'components.native-chat.approval.allow': '허용',
  'components.native-chat.approval.deny': '거부'
} as const

function getLocaleValue(path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return undefined
    }
    return (node as Record<string, unknown>)[segment]
  }, ko)
}

describe('Korean UI semantic mistranslation fixes', () => {
  it('keeps the corrected values in the Korean catalog', () => {
    for (const [path, expected] of Object.entries(correctedValues)) {
      expect(getLocaleValue(path), path).toBe(expected)
    }
  })

  it('keeps the corrected values in the translation overrides', () => {
    const overrides = JSON.parse(
      fs.readFileSync(
        new URL('../../../../config/scripts/locale-ko-key-overrides.json', import.meta.url),
        'utf8'
      )
    ) as Record<string, { ko?: string }>

    for (const [path, expected] of Object.entries(correctedValues)) {
      expect(overrides[path]?.ko, path).toBe(expected)
    }
  })
})
