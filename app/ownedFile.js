import Keychain from './keychain';
import { arrayToB64 } from './utils';
import { del, metadata, setParams, setPassword } from './api';

export default class OwnedFile {
  constructor(obj) {
    this.id = obj.id;
    this.url = obj.url;
    this.name = obj.name;
    this.size = obj.size;
    this.type = obj.type;
    this.time = obj.time;
    this.speed = obj.speed;
    this.createdAt = obj.createdAt;
    this.expiresAt = obj.expiresAt;
    this.keychain = new Keychain(obj.secretKey, obj.nonce);
    this.ownerToken = obj.ownerToken;
    this.dlimit = obj.dlimit || 1;
    this.dtotal = obj.dtotal || 0;
    // TODO a dirty flag for nonce maybe to save to storage?
  }

  async setPassword(password) {
    this.password = password;
    this.keychain.setPassword(password, this.url);
    const result = await setPassword(this.id, this.ownerToken, this.keychain);
    return result;
  }

  del() {
    return del(this.id, this.ownerToken);
  }

  changeLimit(dlimit) {
    this.dlimit = dlimit;
    return setParams(this.id, this.ownerToken, { dlimit });
  }

  async updateDownloadCount() {
    try {
      const result = await metadata(this.id, this.keychain);
      this.dtotal = result.dtotal;
    } catch (e) {
      if (e.message === '404') {
        this.dtotal = this.dlimit;
      }
    }
  }

  toJSON() {
    return {
      id: this.id,
      url: this.url,
      name: this.name,
      size: this.size,
      type: this.type,
      time: this.time,
      speed: this.speed,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      secretKey: arrayToB64(this.keychain.rawSecret),
      nonce: this.keychain.nonce,
      ownerToken: this.ownerToken,
      dlimit: this.dlimit,
      dtotal: this.dtotal
    };
  }
}
