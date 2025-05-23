/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

'use strict';

add_task(async function test_Unload_Changed_Pinned() {
  await SpecialPowers.pushPrefEnv({
    set: [['zen.pinned-tab-manager.close-shortcut-behavior', 'reset-unload-switch']],
  });

  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  await BrowserTestUtils.withNewTab({ gBrowser, url: 'https://example.com/1' }, async (browser) => {
    const tab = gBrowser.getTabForBrowser(browser);
    tab.addEventListener(
      'ZenPinnedTabCreated',
      async function (event) {
        const pinTabID = tab.getAttribute('zen-pin-id');
        ok(pinTabID, 'The tab should have a zen-pin-id attribute after being pinned');

        BrowserTestUtils.startLoadingURIString(browser, 'https://example.com/2');
        await BrowserTestUtils.browserLoaded(browser, false, 'https://example.com/2');
        setTimeout(() => {
          ok(
            tab.hasAttribute('zen-pinned-changed'),
            'The tab should have a zen-pinned-changed attribute after being pinned'
          );
          document.getElementById('cmd_close').doCommand();
          setTimeout(() => {
            ok(
              !tab.hasAttribute('zen-pinned-changed'),
              'The tab should not have a zen-pinned-changed attribute after being closed'
            );

            ok(tab.hasAttribute('discarded'), 'The tab should not be discarded after being closed');
            ok(tab != gBrowser.selectedTab, 'The tab should not be selected after being closed');
            resolvePromise();
          }, 100);
        }, 0);
      },
      { once: true }
    );
    gBrowser.pinTab(tab);
    await promise;
  });
});
