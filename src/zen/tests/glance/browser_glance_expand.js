/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

'use strict';

add_task(async function test_Glance_Basic_Open() {
  const selectedTab = gBrowser.selectedTab;
  await openGlanceOnTab(async (glanceTab) => {
    await gZenGlanceManager.fullyOpenGlance();
    ok(
      !glanceTab.hasAttribute('zen-glance-tab'),
      'The glance tab should not have the zen-glance-tab attribute'
    );
    ok(
      gBrowser.tabs.filter((tab) => tab.hasAttribute('zen-glance-tab')).length === 0,
      'There should be no zen-glance-tab attribute on any tab'
    );
    Assert.greater(
      glanceTab._tPos,
      selectedTab._tPos,
      'The glance tab should be on the right of the selected tab'
    );
    BrowserTestUtils.removeTab(glanceTab);
  }, false);
});

add_task(async function test_Glance_Open_Sibling() {
  const tabsToRemove = [];
  for (let i = 0; i < 5; i++) {
    await BrowserTestUtils.openNewForegroundTab(window.gBrowser, 'https://example.com/', true);
    tabsToRemove.push(gBrowser.selectedTab);
  }

  gBrowser.selectedTab = gBrowser.tabs[2];
  const selectedTab = gBrowser.selectedTab;

  await openGlanceOnTab(async (glanceTab) => {
    await gZenGlanceManager.fullyOpenGlance();
    Assert.equal(
      glanceTab._tPos,
      selectedTab._tPos + 1,
      'The glance tab should be on the right of the selected tab'
    );
    BrowserTestUtils.removeTab(glanceTab);
  }, false);

  for (const tab of tabsToRemove) {
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_Glance_Basic_Open() {
  const tabsToRemove = [];
  for (let i = 0; i < 3; i++) {
    await BrowserTestUtils.openNewForegroundTab(window.gBrowser, 'https://example.com/', true);
    gBrowser.pinTab(gBrowser.selectedTab);
    tabsToRemove.push(gBrowser.selectedTab);
  }

  gBrowser.selectedTab = gBrowser.tabs.find((tab) => tab.pinned);

  await openGlanceOnTab(async (glanceTab) => {
    await gZenGlanceManager.fullyOpenGlance();
    Assert.equal(
      glanceTab._tPos,
      3,
      'The glance tab should be the first normal tab (Ignoring empty tabs)'
    );
    BrowserTestUtils.removeTab(glanceTab);
  }, false);

  for (const tab of tabsToRemove) {
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_Glance_New_From_essential() {
  await BrowserTestUtils.withNewTab({ gBrowser, url: 'https://example.com/' }, async (browser) => {
    const selectedTab = gBrowser.selectedTab;
    gZenPinnedTabManager.addToEssentials(selectedTab);
    await openGlanceOnTab(async (glanceTab) => {
      await gZenGlanceManager.fullyOpenGlance();
      await BrowserTestUtils.openNewForegroundTab(window.gBrowser, 'https://example.com/', true, {
        skipAnimation: true,
      });
      Assert.equal(
        gBrowser.selectedTab._tPos,
        1,
        'The new tab should be the first normal tab (Ignoring empty tabs)'
      );
      Assert.equal(
        glanceTab._tPos,
        2,
        'The glance tab should be the second normal tab (Ignoring empty tabs)'
      );
      await BrowserTestUtils.removeTab(gBrowser.selectedTab);
      BrowserTestUtils.removeTab(glanceTab);
    }, false);
  });
});
