# Testing

## Testing with Nock Fixtures

Some quick notes as I work on this:

- Fixture tests are done against `https://github.com/npm/npm-cli-release-please`. That repo is setup with template-oss, but the `.github/workflows/release.yml` file is removed. Therefore, the release CI won't run on that repo automatically and can instead be done from tests here.
- Those fixtures can be recorded by setting `TEMPLATEOSS_NOCK_RECORD=1`. Otherwise it will default to whether the nock definitions file exists for that test.
- A GitHub token is required for recording, so it must be set with `GITHUB_TOKEN=<token>` when recording fixtures. Otherwise the test suite will explicitly fail.

The `npm/npm-cli-release-please` repo must be in the correct state to record a fixture. This means if you want to record all the nock definitions for creating a PR, then the `main` branch must have pending release commits at the HEAD and there must be no current release PR. This can be tedious to do multiple times, but only needs to be done to record fixtures. Once recorded, all tests are run with `nock.disableNetConnect()` to disable all live http requests.
