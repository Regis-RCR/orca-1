// OpenCode 2 uses the same supported server-plugin loader as OpenCode. The
// variant is kept under the opencode module so config overlays and plugin
// filenames stay isolated from the legacy agent.
export { openCode2HookService as openCode2ConfigHookService } from '../opencode/hook-service'
