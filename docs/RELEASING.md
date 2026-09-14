# Releasing the launcher

Players receive a new version automatically on their next launch (differential download, silent
install, relaunch). The whole chain was verified on 2026-09-14 with v0.1.0 to v0.1.1.

## Steps

1. Make sure `main` is green (`npm run typecheck && npm run build`) and the change is committed.
2. Bump the version (strict semver, must be greater than the last release or nobody updates):
   ```bash
   npm version 0.2.0 --no-git-tag-version
   git commit -am "Release 0.2.0"
   ```
3. Tag and push the tag. The `release` workflow builds Windows, macOS (arm64) and Linux on
   GitHub-hosted runners, publishes the GitHub Release with all installers and the `latest*.yml`
   update manifests, then writes the release notes from `.github/RELEASE_NOTES.md`.
   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin main v0.2.0
   ```
4. Watch https://github.com/underfr/consortium-launcher/actions. About 6 minutes. When the release
   is published (not draft), the installed launchers pick it up at their next start.

## Rules

- Never delete or re-tag a published release: installed launchers compare versions and a
  removed asset breaks their update check.
- Hotfix: bump the patch number, same procedure. There is no "unpublish".
- Windows builds are unsigned for now: the first manual install shows the SmartScreen prompt;
  automatic updates do not.
- macOS auto-update requires a signed and notarized build (Apple Developer account). Until then
  Mac players download the new DMG by hand.
- The release notes file must keep the disclaimer line.
