import {
  resolveProgramStatusIntent,
  type ProgramStatusIntent
} from '../../shared/program-status-intent'
import { argvRequestsServeMode } from '../startup/serve-mode-argv'
import { isProgramStatusDesktopHost } from './program-status-host-authority'

/**
 * This host's answer for one spawn. Only the desktop app's main process arms, for main's PTYs and
 * its local daemon's; a host that never claimed that authority, such as `orcad`, arms nothing. A
 * pane with a `connectionId` is never armed: there is no SSH relay hop any more, and the provider
 * registry refuses an `ssh:` host before spawn options exist.
 */
export function hostProgramStatusIntent(target: {
  connectionId?: string | null
  isDaemonHostSpawn: boolean
}): ProgramStatusIntent | undefined {
  if (!isProgramStatusDesktopHost()) {
    return undefined
  }
  return resolveProgramStatusIntent({
    platform: process.platform,
    provider: target.connectionId ? 'relay' : target.isDaemonHostSpawn ? 'daemon' : 'local',
    // Why argv and not the startup state: the same predicate main's preflight reads.
    serveMode: argvRequestsServeMode(process.argv)
  })
}
