'use strict';

const ZilyStorage = {
  journalKey: 'zily.backup.v1.restore',
  preferencesLockName: 'zily.browser.preferences',

  async withLock(name, task) {
    const locks = globalThis.navigator?.locks;
    if (!locks) throw new Error('此浏览器不支持安全的跨标签页存储写入。');
    return locks.request(name, task);
  },

  withWrite(name, task) {
    return this.withLock(name, () => {
      if (localStorage.getItem(this.journalKey) != null) {
        throw new Error('有未完成的恢复，请先在数据管理中检查恢复。');
      }
      return task();
    });
  },

  withRestoreLocks(names, task) {
    return names.reduceRight((next, name) => () => this.withLock(name, next), task)();
  },
};
