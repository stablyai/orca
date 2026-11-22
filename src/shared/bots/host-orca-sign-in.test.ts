import { describe, expect, it } from 'vitest'
import {
  hostNotSignedIn,
  orcaCloudNeedsSignIn,
  serverSignInSteps,
  thisHost
} from './host-orca-sign-in'

describe('a host that is not signed in to Orca Cloud', () => {
  it('waits on sign-in when signed out or when Orca Cloud refuses its sign-in', () => {
    expect(orcaCloudNeedsSignIn('signed-out')).toBe(true)
    expect(orcaCloudNeedsSignIn('needs-sign-in')).toBe(true)
    for (const status of ['ok', 'unreachable', 'refused', undefined, null]) {
      expect(orcaCloudNeedsSignIn(status)).toBe(false)
    }
  })

  it('reads as this computer on a desktop, with no server steps', () => {
    expect(thisHost(undefined)).toBe('This computer')
    expect(hostNotSignedIn(undefined)).toBe("This computer isn't signed in to Orca Cloud")
    expect(serverSignInSteps(undefined, 'Ranger', 'bot')).toBeNull()
    expect(serverSignInSteps(undefined, 'Ranger', 'owner')).toBeNull()
  })

  it('names a headless server and the command its owner runs there', () => {
    expect(hostNotSignedIn('box1')).toBe("This Orca server (box1) isn't signed in to Orca Cloud")
    expect(serverSignInSteps('box1', 'Ranger', 'bot')).toBe(
      "Your owner can sign it in by running `orca auth login` in a terminal on box1 (`orca auth login --switch` if it says the server is already signed in), or with Sign in on Ranger's Connectors tab in Orca on their computer."
    )
    expect(serverSignInSteps('box1', 'Ranger', 'owner')).toBe(
      "Run `orca auth login` in a terminal on box1 (`orca auth login --switch` if it says the server is already signed in), or use Sign in on Ranger's Connectors tab in Orca on your computer."
    )
  })
})
