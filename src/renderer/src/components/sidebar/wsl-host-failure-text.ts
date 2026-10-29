import { translate } from '@/i18n/i18n'
import {
  WSL_HOST_ADD_REFUSAL_COPY as ADD,
  WSL_HOST_STATUS_DETAIL_COPY as DETAIL,
  WSL_LIST_DISTROS_COMMAND,
  wslSetVersion2Command,
  type WslHostAddRefusalCode,
  type WslHostCopyParams,
  type WslHostStatusDetailCode
} from '../../../../shared/wsl-host-failure-copy'
import {
  getWslHostsPausedLabel,
  getWslHostServerFilesMissingLabel,
  getWslHostsTurnedOffLabel
} from './wsl-host-row-status'

type Values = { text: (name: string) => string | null; count: (name: string) => number | null }

// null = required params missing; the caller shows the host's English text.
const ADD_COPY: Record<WslHostAddRefusalCode, (values: Values) => string | null> = {
  turnedOff: () => getWslHostsTurnedOffLabel(),
  newWorkPaused: () => getWslHostsPausedLabel(),
  serverFilesMissing: () => getWslHostServerFilesMissingLabel(),
  alreadyAdded: ({ text }) => {
    const distro = text('distro')
    return distro === null
      ? null
      : translate('sidebar.wslHosts.addErrors.alreadyAdded', ADD.alreadyAdded, { distro })
  },
  distroStopped: ({ text }) => {
    const distro = text('distro')
    return distro === null
      ? null
      : translate('sidebar.wslHosts.addErrors.distroStopped', ADD.distroStopped, { distro })
  },
  wsl1: ({ text }) => {
    const distro = text('distro')
    return distro === null
      ? null
      : translate('sidebar.wslHosts.addErrors.wsl1', ADD.wsl1, {
          distro,
          command: wslSetVersion2Command(distro)
        })
  },
  notRegistered: ({ text }) => {
    const distro = text('distro')
    return distro === null
      ? null
      : translate('sidebar.wslHosts.addErrors.notRegistered', ADD.notRegistered, {
          distro,
          command: WSL_LIST_DISTROS_COMMAND
        })
  },
  sshManaged: ({ text }) => {
    const distro = text('distro')
    const server = text('server')
    return distro === null || server === null
      ? null
      : translate('sidebar.wslHosts.addErrors.sshManaged', ADD.sshManaged, { distro, server })
  }
}

const DETAIL_COPY: Record<WslHostStatusDetailCode, (values: Values) => string | null> = {
  runningListUnavailable: () =>
    translate(
      'sidebar.wslHosts.statusDetails.runningListUnavailable',
      DETAIL.runningListUnavailable
    ),
  guestUnanswered: () =>
    translate('sidebar.wslHosts.statusDetails.guestUnanswered', DETAIL.guestUnanswered),
  orcadUnanswered: () =>
    translate('sidebar.wslHosts.statusDetails.orcadUnanswered', DETAIL.orcadUnanswered),
  restartGaveUp: ({ text, count: readCount }) => {
    const distro = text('distro')
    const count = readCount('count')
    if (distro === null || count === null) {
      return null
    }
    return translate('sidebar.wslHosts.statusDetails.restartGaveUp', DETAIL.restartGaveUp.other, {
      distro,
      count,
      defaultValue_one: DETAIL.restartGaveUp.one
    })
  },
  serviceUnconfirmed: () =>
    translate('sidebar.wslHosts.statusDetails.serviceUnconfirmed', DETAIL.serviceUnconfirmed),
  peerCheckFailed: ({ text }) => {
    const detail = text('detail')
    return detail === null
      ? null
      : translate('sidebar.wslHosts.statusDetails.peerCheckFailed', DETAIL.peerCheckFailed, {
          detail
        })
  },
  removalUnrecorded: ({ text }) => {
    const detail = text('detail')
    return detail === null
      ? null
      : translate('sidebar.wslHosts.statusDetails.removalUnrecorded', DETAIL.removalUnrecorded, {
          detail
        })
  }
}

function isCopyCode<Code extends string>(copy: Record<Code, unknown>, code: unknown): code is Code {
  return typeof code === 'string' && Object.hasOwn(copy, code)
}

function codedText<Code extends string>(
  copy: Record<Code, (values: Values) => string | null>,
  english: string,
  code: unknown,
  params: WslHostCopyParams | undefined
): string {
  if (!isCopyCode(copy, code)) {
    return english
  }
  const values: Values = {
    text: (name) => (typeof params?.[name] === 'string' ? params[name] : null),
    count: (name) => (typeof params?.[name] === 'number' ? params[name] : null)
  }
  return copy[code](values) ?? english
}

/** Unknown codes (newer main) and uncoded refusals (verbatim errors) show main's English. */
export function wslHostAddRefusalMessage(refusal: {
  message: string
  errorCode?: string
  errorParams?: WslHostCopyParams
}): string {
  return codedText(ADD_COPY, refusal.message, refusal.errorCode, refusal.errorParams)
}

export function wslHostStatusDetailMessage(status: {
  detail: string | null
  detailCode?: string
  detailParams?: WslHostCopyParams
}): string | null {
  return status.detail === null
    ? null
    : codedText(DETAIL_COPY, status.detail, status.detailCode, status.detailParams)
}

export function wslHostStopReasonMessage(stop: {
  reason: string
  reasonCode?: string
  reasonParams?: WslHostCopyParams
}): string {
  return codedText(DETAIL_COPY, stop.reason, stop.reasonCode, stop.reasonParams)
}
