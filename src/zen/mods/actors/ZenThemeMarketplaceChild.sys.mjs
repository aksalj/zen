// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

export class ZenThemeMarketplaceChild extends JSWindowActorChild {
  constructor() {
    super();
  }

  handleEvent(event) {
    switch (event.type) {
      case 'DOMContentLoaded':
        this.initalizeZenAPI(event);
        break;
      default:
    }
  }

  initalizeZenAPI(event) {
    const verifier = this.contentWindow.document.querySelector('meta[name="zen-content-verified"]');

    if (verifier) {
      verifier.setAttribute('content', 'verified');
    }

    const possibleRicePage = this.collectRiceMetadata();

    if (possibleRicePage?.id) {
      this.sendAsyncMessage('ZenThemeMarketplace:RicePage', possibleRicePage);
      return;
    }

    this.initiateThemeMarketplace();
    this.contentWindow.document.addEventListener(
      'ZenCheckForThemeUpdates',
      this.checkForThemeUpdates.bind(this)
    );
  }

  collectRiceMetadata() {
    const meta = this.contentWindow.document.querySelector('meta[name="zen-rice-data"]');
    if (meta) {
      return {
        id: meta.getAttribute('data-id'),
        name: meta.getAttribute('data-name'),
        author: meta.getAttribute('data-author'),
      };
    }
    return null;
  }

  // This function will be called from about:preferences
  checkForThemeUpdates(event) {
    event.preventDefault();
    this.sendAsyncMessage('ZenThemeMarketplace:CheckForUpdates');
  }

  initiateThemeMarketplace() {
    this.contentWindow.setTimeout(() => {
      this.addInstallButtons();
      this.injectMarketplaceAPI();
    }, 0);
  }

  get actionButton() {
    return this.contentWindow.document.getElementById('install-theme');
  }

  get actionButtonUninstall() {
    return this.contentWindow.document.getElementById('install-theme-uninstall');
  }

  async receiveMessage(message) {
    switch (message.name) {
      case 'ZenThemeMarketplace:ThemeChanged': {
        const themeId = message.data.themeId;
        const actionButton = this.actionButton;
        const actionButtonInstalled = this.actionButtonUninstall;

        if (actionButton && actionButtonInstalled) {
          actionButton.disabled = false;
          actionButtonInstalled.disabled = false;

          if (await this.isThemeInstalled(themeId)) {
            actionButton.classList.add('hidden');
            actionButtonInstalled.classList.remove('hidden');
          } else {
            actionButton.classList.remove('hidden');
            actionButtonInstalled.classList.add('hidden');
          }
        }

        break;
      }

      case 'ZenThemeMarketplace:CheckForUpdatesFinished': {
        const updates = message.data.updates;

        this.contentWindow.document.dispatchEvent(
          new CustomEvent('ZenThemeMarketplace:CheckForUpdatesFinished', { detail: { updates } })
        );

        break;
      }

      case 'ZenThemeMarketplace:GetThemeInfo': {
        const themeId = message.data.themeId;
        const theme = await this.getThemeInfo(themeId);

        return theme;
      }
    }
  }

  injectMarketplaceAPI() {
    Cu.exportFunction(this.installTheme.bind(this), this.contentWindow, {
      defineAs: 'ZenInstallTheme',
    });
  }

  async addInstallButtons() {
    const actionButton = this.actionButton;
    const actionButtonUninstall = this.actionButtonUninstall;
    const errorMessage = this.contentWindow.document.getElementById('install-theme-error');
    if (!actionButton || !actionButtonUninstall) {
      return;
    }

    errorMessage.classList.add('hidden');

    const themeId = actionButton.getAttribute('zen-theme-id');
    if (await this.isThemeInstalled(themeId)) {
      actionButtonUninstall.classList.remove('hidden');
    } else {
      actionButton.classList.remove('hidden');
    }

    actionButton.addEventListener('click', this.installTheme.bind(this));
    actionButtonUninstall.addEventListener('click', this.uninstallTheme.bind(this));
  }

  async isThemeInstalled(themeId) {
    return await this.sendQuery('ZenThemeMarketplace:IsThemeInstalled', { themeId });
  }

  addTheme(theme) {
    this.sendAsyncMessage('ZenThemeMarketplace:InstallTheme', { theme });
  }

  getThemeAPIUrl(themeId) {
    return `https://zen-browser.github.io/theme-store/themes/${themeId}/theme.json`;
  }

  async getThemeInfo(themeId) {
    const url = this.getThemeAPIUrl(themeId);
    const data = await fetch(url, {
      mode: 'no-cors',
    });

    if (data.ok) {
      try {
        const obj = await data.json();
        return obj;
      } catch (e) {
        console.error('ZenThemeMarketplace: Error parsing theme info: ', e);
      }
    } else {
      console.error('ZenThemeMarketplace: Error fetching theme info: ', data.status);
    }

    return null;
  }

  async uninstallTheme(event) {
    const button = event.target;
    button.disabled = true;
    const themeId = button.getAttribute('zen-theme-id');
    this.sendAsyncMessage('ZenThemeMarketplace:UninstallTheme', { themeId });
  }

  async installTheme(object) {
    // Object can be an event or a theme id
    let themeId;
    if (object.target) {
      const button = object.target;
      button.disabled = true;
      themeId = button.getAttribute('zen-theme-id');
    } else {
      themeId = object.themeId;
    }
    console.info('ZenThemeMarketplace: Installing theme with id: ', themeId);

    const theme = await this.getThemeInfo(themeId);
    if (!theme) {
      console.error('ZenThemeMarketplace: Error fetching theme info');
      return;
    }
    this.addTheme(theme);
  }
}
