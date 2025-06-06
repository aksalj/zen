<img src="./docs/assets/zen-dark.svg" width="100px" align="left">

### `Zen Browser`

[![Downloads](https://img.shields.io/github/downloads/zen-browser/desktop/total.svg)](https://github.com/zen-browser/desktop/releases)
[![Crowdin](https://badges.crowdin.net/zen-browser/localized.svg)](https://crowdin.com/project/zen-browser)
[![Zen Release builds](https://github.com/zen-browser/desktop/actions/workflows/build.yml/badge.svg?branch=stable)](https://github.com/zen-browser/desktop/actions/workflows/build.yml)

✨ Experience tranquillity while browsing the internet with Zen! Our mission is to give you a balance between speed, privacy and productivity!

<div flex="true">
  <a href="https://zen-browser.app/download">
    Download
  </a>
  •
  <a href="https://zen-browser.app">
    Website
  </a>
  •
  <a href="https://docs.zen-browser.app">
    Documentation
  </a>
  •
  <a href="https://zen-browser.app/release-notes/latest">
    Release Notes
  </a>
</div>

## 🖥️ Compatibility

Zen is currently built using Firefox version `138.0.4`! 🚀

- [`Zen Twilight`](https://zen-browser.app/download?twilight) - Is currently built using Firefox version `RC 138.0.4`!
- Check out the latest [release notes](https://zen-browser.app/release-notes)!
- Part of our mission is to keep Zen up-to-date with the latest version of Firefox, so you can enjoy the latest features and security updates!

## 🤝 Contribution

Zen is an open-source project, and we welcome contributions from the community! Please take a look at the [contribution guidelines](./docs/contribute.md) before getting started!

### Issue metrics

We keep track of how many issues are closed at the end of the month in [docs/issue-metrics](./docs/issue-metrics). We use this to keep track of our issues and see our progress! 📈

### Versioning

Zen uses [Semantic Versioning](https://semver.org/), meaning versions are displayed as `a.b.cd` where:

- `a` is the major version
- `b` is the minor version
- `c` is the branch prefix
- `d` is the patch version

### Branches

Zen is divided into 2 main branches. We use `dev` for development and `stable` for stable releases. The `dev` branch is where all the new features are added and where `twilight` builds are generated. The `stable` branch is where the stable releases are generated.

We divide into 2 branches in case there's any really important security update (for example) that needs to be released before the next stable release. This allows us to do patches without releasing unstable versions to the public.

## 📥 Installation

### Supported Operating Systems

Zen is available for Linux, macOS, and Windows. You can download the latest version from the official website at [zen-browser.app](https://zen-browser.app/download), or from the [GitHub Releases](https://github.com/zen-browser/desktop/releases) page.

If you don't see your OS listed below, that's because we already have it in our [downloads page](https://zen-browser.app/download)! Make sure to check it out!

#### Windows

##### Winget

```ps
winget install --id Zen-Team.Zen-Browser
```

#### macOS

- Requires macOS 10.15 or later
- Available for ARM and Intel architectures

You can also install Zen using Homebrew:

```
brew install zen-browser
```

#### Linux

##### Arch-based distributions

```sh
yay -S zen-browser-bin
```

##### Other Linux distributions (Tarball or AppImage)

- `Tarball` install:

```sh
bash <(curl -s https://updates.zen-browser.app/install.sh)
```

- `AppImage` install:

```sh
bash <(curl https://updates.zen-browser.app/appimage.sh)
```

> AppImage install requires `zsync` for the Update feature

- Again, if you don't see your OS listed above, that's because we already have it in our [downloads page](https://zen-browser.app/download)! 🔄

To upgrade the browser to a newer version, use the embedded update functionality in `About Zen`.

## 👨‍💻 Development and Contributing

Some components used by @zen-browser as an attempt to make Firefox forks a better place, and for other to enjoy the beauty of OSS. You can find them [here](https://github.com/zen-browser/desktop/tree/dev/src/zen).

#### `Run Locally`

In order to download and run Zen locally, please follow [these instructions](https://docs.zen-browser.app/guides/building).

#### `Special Thanks`

Special thanks to... EVERYONE 🎉! Checkout the team and contributors page [here](https://zen-browser.app/about)

#### `Third Party Code`

Zen couldn't be in its current state without the help of these amazing projects! 🙏

- Zen's default preferences are based on [BetterFox](https://github.com/yokoffing/Betterfox)
- Gradient image extracted from [Arc Palette](https://github.com/neurokitti/Arc_Palette)
- `icons.css` has been modified from [Edge Firefox](https://github.com/bmFtZQ/edge-frfox) (MIT licensed file).

### 🖥️ Comparison with other browsers

Thanks everyone for making Zen stand out among these giants!

[![Star History Chart](https://api.star-history.com/svg?repos=zen-browser/desktop,chromium/chromium,brave/brave-browser&type=Date)](https://star-history.com/#zen-browser/desktop&chromium/chromium&brave/brave-browser&Date)

## 📄 License

Zen browser is under the [MPL 2.0 LICENSE](./LICENSE). All the code is open-source and free to use! Attribution is appreciated but not required.
