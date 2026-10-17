import { isProgramStatusPlatform } from '../../../../shared/program-status-intent'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'

/** Why: ingestion arms only where isProgramStatusPlatform holds, so elsewhere the switch would
 *  change nothing. The row and its search entry both read this. */
export function isAgentProgramStatusAvailable(): boolean {
  return isProgramStatusPlatform(getRendererAppPlatform())
}
