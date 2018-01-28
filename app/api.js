import { arrayToB64, b64ToArray } from './utils';

function post(obj) {
  return {
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(obj)
  };
}

function parseNonce(header) {
  header = header || '';
  return header.split(' ')[1];
}

async function fetchWithAuth(url, params, keychain) {
  const result = {};
  params = params || {};
  const h = await keychain.authHeader();
  params.headers = new Headers({ Authorization: h });
  const response = await fetch(url, params);
  result.response = response;
  result.ok = response.ok;
  const nonce = parseNonce(response.headers.get('WWW-Authenticate'));
  result.shouldRetry = response.status === 401 && nonce !== keychain.nonce;
  keychain.nonce = nonce;
  return result;
}

async function fetchWithAuthAndRetry(url, params, keychain) {
  const result = await fetchWithAuth(url, params, keychain);
  if (result.shouldRetry) {
    return fetchWithAuth(url, params, keychain);
  }
  return result;
}

export async function del(id, owner_token) {
  const response = await fetch(`/api/delete/${id}`, post({ owner_token }));
  return response.ok;
}

export async function setParams(id, owner_token, params) {
  const response = await fetch(
    `/api/params/${id}`,
    post({
      owner_token,
      dlimit: params.dlimit
    })
  );
  return response.ok;
}

export async function metadata(id, keychain) {
  const result = await fetchWithAuthAndRetry(
    `/api/metadata/${id}`,
    { method: 'GET' },
    keychain
  );
  if (result.ok) {
    const data = await result.response.json();
    const meta = await keychain.decryptMetadata(b64ToArray(data.metadata));
    return {
      dtotal: data.dtotal,
      dlimit: data.dlimit,
      size: data.size,
      ttl: data.ttl,
      iv: meta.iv,
      name: meta.name,
      type: meta.type
    };
  }
  throw new Error(result.response.status);
}

export async function setPassword(id, owner_token, keychain) {
  const auth = await keychain.authKeyB64();
  const response = await fetch(
    `/api/password/${id}`,
    post({ owner_token, auth })
  );
  return response.ok;
}

export function uploadFile(encrypted, metadata, verifierB64, keychain) {
  const xhr = new XMLHttpRequest();
  const upload = {
    onprogress: function() {},
    cancel: function() {
      xhr.abort();
    },
    result: new Promise(function(resolve, reject) {
      xhr.addEventListener('loadend', function() {
        const authHeader = xhr.getResponseHeader('WWW-Authenticate');
        if (authHeader) {
          keychain.nonce = parseNonce(authHeader);
        }
        if (xhr.status === 200) {
          const responseObj = JSON.parse(xhr.responseText);
          return resolve({
            url: responseObj.url,
            id: responseObj.id,
            ownerToken: responseObj.owner
          });
        }
        reject(new Error(xhr.status));
      });
    })
  };
  const dataView = new DataView(encrypted);
  const blob = new Blob([dataView], { type: 'application/octet-stream' });
  const fd = new FormData();
  fd.append('data', blob);
  xhr.upload.addEventListener('progress', function(event) {
    if (event.lengthComputable) {
      upload.onprogress([event.loaded, event.total]);
    }
  });
  xhr.open('post', '/api/upload', true);
  xhr.setRequestHeader('X-File-Metadata', arrayToB64(new Uint8Array(metadata)));
  xhr.setRequestHeader('Authorization', `send-v1 ${verifierB64}`);
  xhr.send(fd);
  return upload;
}

function download(id, keychain) {
  const xhr = new XMLHttpRequest();
  const download = {
    onprogress: function() {},
    cancel: function() {
      xhr.abort();
    },
    result: new Promise(async function(resolve, reject) {
      xhr.addEventListener('loadend', function() {
        const authHeader = xhr.getResponseHeader('WWW-Authenticate');
        if (authHeader) {
          keychain.nonce = parseNonce(authHeader);
        }
        if (xhr.status === 404) {
          return reject(new Error('notfound'));
        }
        if (xhr.status !== 200) {
          return reject(new Error(xhr.status));
        }

        const blob = new Blob([xhr.response]);
        const fileReader = new FileReader();
        fileReader.readAsArrayBuffer(blob);
        fileReader.onload = function() {
          resolve(this.result);
        };
      });
      xhr.addEventListener('progress', function(event) {
        if (event.lengthComputable && event.target.status === 200) {
          download.onprogress([event.loaded, event.total]);
        }
      });
      const auth = await keychain.authHeader();
      xhr.open('get', `/api/download/${id}`);
      xhr.setRequestHeader('Authorization', auth);
      xhr.responseType = 'blob';
      xhr.send();
    })
  };

  return download;
}

async function tryDownload(id, keychain, onprogress, tries = 1) {
  const dl = download(id, keychain);
  dl.onprogress = onprogress;
  try {
    const result = await dl.result;
    return result;
  } catch (e) {
    if (e.message === '401' && --tries > 0) {
      return tryDownload(id, keychain, onprogress, tries);
    }
    throw e;
  }
}

export function downloadFile(id, keychain) {
  let cancelled = false;
  function updateProgress(p) {
    if (cancelled) {
      // This is a bit of a hack
      // We piggyback off of the progress event as a chance to cancel.
      // Otherwise wiring the xhr abort up while allowing retries
      // gets pretty nasty.
      // 'this' here is the object returned by download(id, keychain)
      return this.cancel();
    }
    dl.onprogress(p);
  }
  const dl = {
    onprogress: function() {},
    cancel: function() {
      cancelled = true;
    },
    result: tryDownload(id, keychain, updateProgress, 2)
  };
  return dl;
}
