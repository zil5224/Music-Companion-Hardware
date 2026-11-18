'use strict';

{
  const panel = document.getElementById('playlistLibraryPanel');
  const list = document.getElementById('playlistLibraryList');
  const detail = document.getElementById('playlistLibraryDetail');
  const status = document.getElementById('playlistLibraryStatus');
  let filter = 'all';
  let editing = null;
  let dirty = false;
  let busy = false;
  let search = null;

  function el(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function action(text, run, options) {
    return queueButton(text, run, options);
  }

  function field(label, input) {
    const node = el('label', label);
    node.append(input);
    return node;
  }

  function inputText(value, limit, multiline = false) {
    const input = el(multiline ? 'textarea' : 'input');
    input.maxLength = limit;
    input.value = value;
    return input;
  }

  function option(label, value) {
    const item = el('option', label);
    item.value = value;
    return item;
  }

  function cover(url) {
    if (!url) {
      const placeholder = el('span', '♫');
      placeholder.className = 'queue-cover-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      return placeholder;
    }
    const image = el('img');
    image.src = url;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    return image;
  }

  function controls(...buttons) {
    const row = el('div');
    row.className = 'queue-actions';
    row.append(...buttons);
    return row;
  }

  function warnUnsaved(event) {
    event.preventDefault();
    event.returnValue = true;
  }

  function resetEditor() {
    window.removeEventListener('beforeunload', warnUnsaved);
    search?.abort();
    search = null;
    editing = null;
    dirty = false;
  }

  function loadList() {
    resetEditor();
    try { renderList(playlistLibrary.read()); }
    catch (error) {
      list.hidden = false;
      list.replaceChildren();
      detail.hidden = true;
      detail.replaceChildren();
      status.textContent = error.message;
    }
  }

  async function write(run, done, onConflict) {
    if (busy) return;
    busy = true;
    panel.setAttribute('aria-busy', 'true');
    list.inert = detail.inert = true;
    try {
      const result = await run();
      done(result);
    } catch (error) {
      if (error.code === 'revision_conflict') {
        if (onConflict) {
          try { onConflict(); } catch (conflictError) { status.textContent = conflictError.message; }
          return;
        }
        if (editing?.id && !dirty) openPlaylist(editing.id);
        else if (!editing) loadList();
      }
      status.textContent = error.message;
    } finally {
      busy = false;
      panel.removeAttribute('aria-busy');
      list.inert = detail.inert = false;
    }
  }

  function renderList(data) {
    detail.hidden = true;
    detail.replaceChildren();
    list.hidden = false;
    const filters = el('select');
    filters.append(option('全部歌单', 'all'));
    if (data.playlists.some(playlist => playlist.categoryId === null)) filters.append(option('未分类', 'none'));
    filters.append(...data.categories.map(category => option(category.name, category.id)));
    if (![...filters.options].some(item => item.value === filter)) filter = 'all';
    filters.value = filter;
    filters.addEventListener('change', () => {
      if (busy) { filters.value = filter; return; }
      filter = filters.value;
      loadList();
    });

    const categories = el('details');
    categories.append(el('summary', '管理分类'));
    const createName = inputText('', 60);
    createName.required = true;
    const createForm = el('form');
    const createButton = el('button', '新建分类');
    createButton.className = 'mood-chip';
    createForm.append(field('分类名称', createName), createButton);
    createForm.addEventListener('submit', event => {
      event.preventDefault();
      void write(() => playlistLibrary.saveCategory(createName.value), () => {
        loadList();
        list.querySelector('details').open = true;
        status.textContent = '分类已创建。';
      });
    });
    categories.append(createForm);
    for (const category of data.categories) {
      const name = inputText(category.name, 60);
      name.required = true;
      const form = el('form');
      const save = el('button', '保存名称');
      save.className = 'mood-chip';
      const remove = action('删除分类', () => {
        if (busy || !window.confirm('删除分类「' + category.name + '」？其中的歌单会保留，并移到未分类。')) return;
        void write(() => playlistLibrary.removeCategory(category.id, category.revision), () => {
          loadList();
          list.querySelector('details').open = true;
          status.textContent = '分类已删除，歌单已保留。';
        });
      });
      form.append(field('分类「' + category.name + '」', name), save, remove);
      form.addEventListener('submit', event => {
        event.preventDefault();
        void write(() => playlistLibrary.saveCategory(name.value, category.id, category.revision), () => {
          loadList();
          list.querySelector('details').open = true;
          status.textContent = '分类名称已保存。';
        });
      });
      categories.append(form);
    }

    const grid = el('div');
    grid.className = 'playlist-library-grid';
    const shown = data.playlists.filter(playlist => filter === 'all' || playlist.categoryId === (filter === 'none' ? null : filter))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const playlist of shown) {
      const card = el('article');
      const metadata = el('div');
      const category = data.categories.find(item => item.id === playlist.categoryId);
      const open = action(playlist.name, () => { if (!busy) openPlaylist(playlist.id); }, { label: '打开歌单「' + playlist.name + '」' });
      const date = el('time', new Date(playlist.updatedAt).toLocaleString('zh-CN'));
      date.dateTime = playlist.updatedAt;
      metadata.append(open, el('p', playlist.description),
        el('small', playlist.tracks.length + ' 首 · ' + (category?.name || '未分类')), date);
      card.append(cover(playlist.tracks[0]?.coverUrl), metadata);
      grid.append(card);
    }
    if (!shown.length) grid.append(el('p', filter === 'all' ? '还没有保存的歌单。' : '这个分类还没有歌单。'));
    list.replaceChildren(controls(action('新建空白歌单', () => {
      if (busy) return;
      try {
        renderEditor({ name: '', description: '', categoryId: null, tracks: [] }, playlistLibrary.read());
        status.textContent = '';
      } catch (error) { status.textContent = error.message; }
    })), field('筛选歌单', filters), categories, grid);
  }

  function openPlaylist(id) {
    try {
      const data = playlistLibrary.read();
      const playlist = data.playlists.find(item => item.id === id);
      if (!playlist) {
        loadList();
        status.textContent = '这份歌单已删除。';
        return;
      }
      renderEditor(playlist, data);
      status.textContent = '';
    } catch (error) { status.textContent = error.message; }
  }

  function renderEditor(playlist, data) {
    resetEditor();
    editing = playlist;
    list.hidden = true;
    detail.hidden = false;
    const editor = el('form');
    const name = inputText(playlist.name, 60);
    name.required = true;
    const description = inputText(playlist.description, 500, true);
    const category = el('select');
    category.append(option('未分类', ''), ...data.categories.map(item => option(item.name, item.id)));
    category.value = playlist.categoryId || '';
    const tracks = playlist.tracks.slice();
    const rows = el('ol');
    const save = el('button', '保存歌单');
    save.className = 'mood-chip';
    const changed = () => {
      dirty = true;
      window.addEventListener('beforeunload', warnUnsaved);
      status.textContent = '有尚未保存的更改。';
    };
    const conflict = el('section');
    conflict.hidden = true;
    let revision = playlist.revision;
    const values = () => ({ name: name.value, description: description.value,
      categoryId: category.value || null, tracks: tracks.slice() });
    function showConflict() {
      const fresh = playlistLibrary.read();
      const latest = fresh.playlists.find(item => item.id === playlist.id);
      changed();
      status.textContent = '歌单已在另一页面更新，本地草稿已保留。';
      conflict.hidden = false;
      const comparison = el('details');
      comparison.open = true;
      comparison.append(el('summary', '查看当前已保存版本'));
      if (latest) {
        const savedCategory = fresh.categories.find(item => item.id === latest.categoryId);
        comparison.append(el('p', latest.name + ' · ' + (savedCategory?.name || '未分类') + ' · 版本 ' + latest.revision),
          el('p', latest.description));
        const songs = el('ol');
        for (const track of latest.tracks) songs.append(el('li', track.title + ' · ' + track.artist +
          (track.phase ? ' · ' + track.phase : '') + (track.reason ? ' · ' + track.reason : '')));
        comparison.append(songs);
      } else comparison.append(el('p', '这份歌单已经删除。'));
      conflict.replaceChildren(comparison, controls(action('将草稿另存为歌单', () => {
        const draft = values();
        void write(async () => {
          if (draft.categoryId && !playlistLibrary.read().categories.some(item => item.id === draft.categoryId)) {
            if (!window.confirm('原分类已删除，是否将草稿另存为未分类歌单？')) return;
            draft.categoryId = null;
          }
          return playlistLibrary.create(draft);
        }, saved => {
          if (!saved) return;
          openPlaylist(saved.id);
          status.textContent = '草稿已另存为歌单。';
        });
      })));
      if (!latest) return;
      conflict.append(controls(action('基于此版本继续编辑', () => {
        if (!window.confirm('保留本地草稿并以此版本为编辑基准？再次保存时将提交草稿内容。')) return;
        const selected = category.value;
        const currentCategories = fresh.categories.map(item => option(item.name, item.id));
        if (selected && !fresh.categories.some(item => item.id === selected)) {
          currentCategories.push(option('原分类已删除，请重新选择', selected));
        }
        category.replaceChildren(option('未分类', ''), ...currentCategories);
        category.value = selected;
        revision = latest.revision;
        conflict.hidden = true;
        changed();
      }), action('放弃草稿并载入已保存版本', () => {
        if (window.confirm('放弃当前草稿？')) openPlaylist(latest.id);
      })));
    }
    editor.addEventListener('input', changed);
    editor.addEventListener('submit', event => {
      event.preventDefault();
      const draft = values();
      void write(() => playlist.id ? playlistLibrary.update(playlist.id, revision, draft) : playlistLibrary.create(draft),
        saved => {
          openPlaylist(saved.id);
          status.textContent = '歌单已保存。';
        }, showConflict);
    });
    editor.append(field('歌单名称', name), field('描述', description), field('所属分类', category), save, conflict);

    const verifyForm = el('form');
    const title = inputText('', 100);
    const artist = inputText('', 100);
    title.required = artist.required = true;
    const verify = el('button', '核验歌曲');
    verify.className = 'mood-chip';
    const results = el('div');
    results.className = 'playlist-library-search';
    verifyForm.append(field('歌名', title), field('歌手', artist), verify);
    verifyForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !title.value.trim() || !artist.value.trim()) return;
      search?.abort();
      const controller = new AbortController();
      search = controller;
      results.textContent = '正在核对网易云曲库…';
      try {
        const matches = playlistOptions(await verifyMusicTrack(title.value.trim(), artist.value.trim(), controller.signal, { keepVersions: true }));
        if (search !== controller) return;
        if (!matches.length) results.textContent = '找不到匹配歌曲，请确认歌名和歌手。';
        else results.replaceChildren(...matches.map(track => action(
          '添加《' + track.song + '》· ' + track.artist + (track.album ? ' · ' + track.album : '') +
          (track.durationMs ? ' · ' + Math.round(track.durationMs / 1000) + ' 秒' : ''), () => {
            if (busy || editing !== playlist || !panel.matches(':popover-open')) return;
            if (tracks.length >= PLAYLIST_TRACK_LIMIT) {
              status.textContent = '一份歌单最多保存 ' + PLAYLIST_TRACK_LIMIT + ' 首。';
              return;
            }
            try {
              tracks.push(playlistCatalogTrack(track));
              changed();
              renderTracks();
            } catch (error) { status.textContent = error.message; }
          })));
      } catch {
        if (search === controller) results.textContent = '曲库核验失败，请稍后重试。';
      }
    });

    function renderTracks() {
      rows.replaceChildren(...tracks.map((track, i) => {
        const row = el('li');
        row.className = 'queue-entry';
        const move = (offset) => {
          if (busy || !tracks[i + offset]) return;
          [tracks[i], tracks[i + offset]] = [tracks[i + offset], tracks[i]];
          changed();
          renderTracks();
          rows.children[i + offset]?.querySelector(offset < 0 ? '[data-up]' : '[data-down]')?.focus();
        };
        const up = action('上移', () => move(-1), { disabled: i === 0, label: '上移 ' + track.title });
        const down = action('下移', () => move(1), { disabled: i === tracks.length - 1, label: '下移 ' + track.title });
        up.dataset.up = '';
        down.dataset.down = '';
        const remove = action('移除', () => {
          if (busy) return;
          tracks.splice(i, 1);
          changed();
          renderTracks();
        }, { label: '移除 ' + track.title });
        row.append(cover(track.coverUrl), el('p', (i + 1) + '. ' + track.title + ' · ' + track.artist));
        const notes = el('details');
        notes.className = 'playlist-track-notes';
        const summary = el('summary', '编辑阶段与理由');
        const phase = inputText(track.phase, 40);
        const reason = inputText(track.reason, 160);
        const noteText = el('small');
        const updateNoteText = () => {
          noteText.textContent = [phase.value, reason.value].filter(Boolean).join(' · ');
          noteText.hidden = !noteText.textContent;
        };
        notes.append(summary, field('阶段', phase), field('理由', reason));
        notes.addEventListener('input', () => {
          tracks[i] = { ...track, phase: phase.value, reason: reason.value };
          updateNoteText();
          changed();
        });
        updateNoteText();
        row.append(noteText, notes);
        row.append(controls(action('加入队列', () => addQueueTrack(playlistQueueTracks([track])[0], status),
          { label: '把《' + track.title + '》加入队列' }), up, down, remove));
        return row;
      }));
      if (!tracks.length) rows.append(el('li', '这份歌单还没有歌曲。'));
    }

    const back = action('返回全部歌单', () => {
      if (busy || (dirty && !window.confirm('返回列表并放弃这次未保存的修改？'))) return;
      filter = 'all';
      loadList();
      status.textContent = '';
    });
    const actions = controls(back);
    if (playlist.id) {
      let starting = false;
      const useSaved = () => {
        if (!dirty) return true;
        status.textContent = '请先保存更改，再使用整份歌单。';
        return false;
      };
      actions.append(action('全部加入队列', () => {
        if (useSaved()) status.textContent = '已加入 ' + playbackQueue.addMany(playlistQueueTracks(playlist.tracks)) + ' 首。';
      }, { disabled: !playlist.tracks.length }), action('播放这份歌单', async () => {
        if (starting || !useSaved()) return;
        starting = true;
        status.textContent = '正在把歌单送入播放队列…';
        try {
          const started = await playbackQueue.playTracks(playlistQueueTracks(playlist.tracks));
          if (editing === playlist) status.textContent = started ? playbackQueue.message : '播放器正在切歌，请稍后再试。';
        } catch {
          if (editing === playlist) status.textContent = '播放器未能开始播放。';
        } finally { starting = false; }
      }, { disabled: !playlist.tracks.length }), action('参考这份歌单生成', () => {
        if (busy || !useSaved()) return;
        if (chatPending && !activeChat?.playlistDraft) {
          status.textContent = '请等待当前对话结束后再生成。';
          return;
        }
        panel.hidePopover();
        void sendMessage(false, '参考已保存歌单《' + playlist.name + '》的情绪走向，换一批歌曲，生成一份新歌单。',
          playlistReference(playlist));
      }), action('删除歌单', () => {
        if (busy || !window.confirm('确认删除歌单「' + playlist.name + '」？此操作无法撤销。')) return;
        void write(() => playlistLibrary.remove(playlist.id, playlist.revision), () => {
          loadList();
          status.textContent = '歌单已删除。';
        });
      }));
    }
    detail.replaceChildren(el('h3', playlist.id ? '编辑歌单' : '新建空白歌单'), actions, editor,
      el('h3', '曲目'), verifyForm, results, rows);
    renderTracks();
  }

  panel.addEventListener('beforetoggle', event => {
    if (event.newState === 'closed') {
      if (search) {
        search.abort();
        search = null;
        const results = detail.querySelector('.playlist-library-search');
        if (results?.textContent === '正在核对网易云曲库…') results.textContent = '';
      }
    } else if (!editing || !dirty) {
      status.textContent = '';
      if (editing?.id) openPlaylist(editing.id);
      else loadList();
    }
  });
  window.addEventListener('storage', event => {
    if (event.key !== PLAYLIST_LIBRARY_KEY && event.key !== null) return;
    if (busy || !panel.matches(':popover-open')) return;
    if (dirty) status.textContent = '另一标签页更新了歌单。保存时会检查版本。';
    else if (editing?.id) openPlaylist(editing.id);
    else loadList();
  });
}
