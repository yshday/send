import FileSender from './fileSender';
import FileReceiver from './fileReceiver';
import {
  copyToClipboard,
  delay,
  fadeOut,
  openLinksInNewTab,
  percent,
  saveFile
} from './utils';
import * as metrics from './metrics';

export default function(state, emitter) {
  let lastRender = 0;
  let updateTitle = false;

  function render() {
    emitter.emit('render');
  }

  async function checkFiles() {
    const files = state.storage.files;
    let rerender = false;
    for (const file of files) {
      const oldLimit = file.dlimit;
      const oldTotal = file.dtotal;
      await file.updateDownloadCount();
      if (file.dtotal === file.dlimit) {
        state.storage.remove(file.id);
        rerender = true;
      } else if (oldLimit !== file.dlimit || oldTotal !== file.dtotal) {
        rerender = true;
      }
    }
    console.log('check please');
    if (rerender) {
      console.log('rerender');
      render();
    }
  }

  function updateProgress() {
    if (updateTitle) {
      emitter.emit('DOMTitleChange', percent(state.transfer.progressRatio));
    }
    render();
  }

  emitter.on('DOMContentLoaded', () => {
    document.addEventListener('blur', () => (updateTitle = true));
    document.addEventListener('focus', () => {
      updateTitle = false;
      emitter.emit('DOMTitleChange', 'Firefox Send');
    });
    checkFiles();
  });

  emitter.on('navigate', checkFiles);

  emitter.on('render', () => {
    lastRender = Date.now();
  });

  emitter.on('changeLimit', async ({ file, value }) => {
    await file.changeLimit(value);
    state.storage.writeFiles();
    metrics.changedDownloadLimit(file);
  });

  emitter.on('delete', async ({ file, location }) => {
    try {
      metrics.deletedUpload({
        size: file.size,
        time: file.time,
        speed: file.speed,
        type: file.type,
        ttl: file.expiresAt - Date.now(),
        location
      });
      state.storage.remove(file.id);
      await file.del();
    } catch (e) {
      state.raven.captureException(e);
    }
  });

  emitter.on('cancel', () => {
    state.transfer.cancel();
  });

  emitter.on('upload', async ({ file, type }) => {
    const size = file.size;
    const sender = new FileSender(file);
    sender.on('progress', updateProgress);
    sender.on('encrypting', render);
    state.transfer = sender;
    render();

    const links = openLinksInNewTab();
    await delay(200);
    try {
      metrics.startedUpload({ size, type });
      const ownedFile = await sender.upload();
      state.storage.totalUploads += 1;
      metrics.completedUpload(ownedFile);

      state.storage.addFile(ownedFile);

      document.getElementById('cancel-upload').hidden = 'hidden';
      await delay(1000);
      await fadeOut('upload-progress');
      openLinksInNewTab(links, false);
      state.transfer = null;

      emitter.emit('pushState', `/share/${ownedFile.id}`);
    } catch (err) {
      console.error(err);
      state.transfer = null;
      if (err.message === '0') {
        //cancelled. do nothing
        metrics.cancelledUpload({ size, type });
        return render();
      }
      state.raven.captureException(err);
      metrics.stoppedUpload({ size, type, err });
      emitter.emit('pushState', '/error');
    }
  });

  emitter.on('password', async ({ password, file }) => {
    try {
      await file.setPassword(password);
      state.storage.writeFiles();
      metrics.addedPassword({ size: file.size });
    } catch (e) {
      console.error(e);
    }
    render();
  });

  emitter.on('getMetadata', async () => {
    const file = state.fileInfo;
    const receiver = new FileReceiver(file);
    try {
      await receiver.getMetadata();
      receiver.on('progress', updateProgress);
      receiver.on('decrypting', render);
      state.transfer = receiver;
    } catch (e) {
      if (e.message === '401') {
        file.password = null;
        if (!file.requiresPassword) {
          return emitter.emit('pushState', '/404');
        }
      }
    }
    render();
  });

  emitter.on('download', async file => {
    state.transfer.on('progress', render);
    state.transfer.on('decrypting', render);
    const links = openLinksInNewTab();
    const size = file.size;
    try {
      const start = Date.now();
      metrics.startedDownload({ size: file.size, ttl: file.ttl });
      const f = await state.transfer.download();
      const time = Date.now() - start;
      const speed = size / (time / 1000);
      await delay(1000);
      await fadeOut('download-progress');
      saveFile(f);
      state.storage.totalDownloads += 1;
      state.transfer = null;
      metrics.completedDownload({ size, time, speed });
      emitter.emit('pushState', '/completed');
    } catch (err) {
      if (err.message === '0') {
        // download cancelled
        return render();
      }
      console.error(err);
      const location = err.message === 'notfound' ? '/404' : '/error';
      if (location === '/error') {
        state.raven.captureException(err);
        metrics.stoppedDownload({ size, err });
      }
      emitter.emit('pushState', location);
    } finally {
      state.transfer = null;
      openLinksInNewTab(links, false);
    }
  });

  emitter.on('copy', ({ url, location }) => {
    copyToClipboard(url);
    metrics.copiedLink({ location });
  });

  setInterval(() => {
    // poll for updates of the download counts
    // TODO something for the share page: || state.route === '/share/:id'
    if (state.route === '/') {
      checkFiles();
    }
  }, 2 * 60 * 1000);

  setInterval(() => {
    // poll for rerendering the file list countdown timers
    if (
      state.route === '/' &&
      state.storage.files.length > 0 &&
      Date.now() - lastRender > 30000
    ) {
      render();
    }
  }, 60000);
}
