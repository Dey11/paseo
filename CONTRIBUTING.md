# Contributing to HanabiCode

HanabiCode is a personal downstream of [Paseo](https://github.com/getpaseo/paseo). Bug reports and focused pull requests are welcome in [HanabiCode issues](https://github.com/Dey11/paseo/issues). Discuss larger product or architecture changes in [HanabiCode Discussions](https://github.com/Dey11/paseo/discussions) before implementing them.

## Before opening a pull request

- Read [the fork docs](docs/fork-docs/README.md) and the subject documentation for the area you will change.
- Keep the change focused and preserve protocol compatibility.
- Add tests that exercise the real behavior.
- Run targeted tests, `npm run typecheck`, `npm run lint`, and `npm run format:check`.
- Include screenshots or a short recording for visible UI changes.
- State which platforms you tested and which you did not.

The [QA guide](docs/qa.md) defines the evidence expected for each surface. If an agent helped investigate a bug, include the raw logs and reproduction steps rather than only its diagnosis.

## Licensing

Contributions are accepted under the repository's [Apache License 2.0](LICENSE). Do not submit code that HanabiCode cannot legally redistribute. Keep upstream copyright and license notices intact.

## Upstream changes

If a change belongs in the general Paseo product rather than this downstream, you may also propose it to [getpaseo/paseo](https://github.com/getpaseo/paseo). HanabiCode has its own release and product decisions; acceptance here does not imply upstream acceptance.
