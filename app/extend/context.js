'use strict';

const Readable = require('stream').Readable;
const path = require('path');
const uuid = require('uuid');
const parse = require('co-busboy');
const sendToWormhole = require('stream-wormhole');
const moment = require('moment');
const fs = require('mz/fs');
const mkdirp = require('mz-modules/mkdirp');
const pump = require('mz-modules/pump');
const rimraf = require('mz-modules/rimraf');

// 继承自原生stream模块的Readable。
class EmptyStream extends Readable {
  _read() {
    this.push(null);
  }
}

const HAS_CONSUMED = Symbol('Context#multipartHasConsumed');

async function limit(code, message) {
  // throw 413 error
  const err = new Error(message);
  err.code = code;
  err.status = 413;
  throw err;
}

// 给外暴露给ctx上的方法和属性
module.exports = {
  /**
   * clean up request tmp files helper
   * @function Context#cleanupRequestFiles
   * @param {Array<String>} [files] - file paths need to clenup, default is `ctx.request.files`.
   */
  // 清空请求文件
  async cleanupRequestFiles(files) {
    // 如果不传参数，默认参数给出ctx.request.files
    if (!files || !files.length) {
      files = this.request.files;
    }
    if (Array.isArray(files)) {
      for (const file of files) {
        try {
          // 清空文件
          await rimraf(file.filepath);
        } catch (err) {
          // warning log
          this.coreLogger.warn('[egg-multipart-cleanupRequestFiles-error] file: %j, error: %s',
            file, err);
        }
      }
    }
  },

  /**
   * save request multipart data and files to `ctx.request`
   * @function Context#saveRequestFiles
   * @param {Object} options
   *  - {String} options.defCharset
   *  - {Object} options.limits
   *  - {Function} options.checkFile
   */
  // 保存请求文件
  async saveRequestFiles(options) {
    options = options || {};
    const ctx = this;

    const multipartOptions = {
      autoFields: false,
    };
    if (options.defCharset) multipartOptions.defCharset = options.defCharset;
    if (options.limits) multipartOptions.limits = options.limits;
    if (options.checkFile) multipartOptions.checkFile = options.checkFile;

    let storedir;

    const requestBody = {};
    const requestFiles = [];

    const parts = ctx.multipart(multipartOptions);
    // 获取文件内容
    let part;
    do {
      try {
        part = await parts();
      } catch (err) {
        await ctx.cleanupRequestFiles(requestFiles);
        throw err;
      }

      if (!part) break;

      if (part.length) {
        ctx.coreLogger.debug('[egg-multipart:storeMultipart] handle value part: %j', part);
        const fieldnameTruncated = part[2];
        const valueTruncated = part[3];
        if (valueTruncated) {
          await ctx.cleanupRequestFiles(requestFiles);
          return await limit('Request_fieldSize_limit', 'Reach fieldSize limit');
        }
        if (fieldnameTruncated) {
          await ctx.cleanupRequestFiles(requestFiles);
          return await limit('Request_fieldNameSize_limit', 'Reach fieldNameSize limit');
        }

        // arrays are busboy fields
        requestBody[part[0]] = part[1];
        continue;
      }

      // otherwise, it's a stream
      const meta = {
        field: part.fieldname,
        filename: part.filename,
        encoding: part.encoding,
        mime: part.mime,
      };
      // keep same property name as file stream
      // https://github.com/cojs/busboy/blob/master/index.js#L114
      meta.fieldname = meta.field;
      meta.transferEncoding = meta.encoding;
      meta.mimeType = meta.mime;

      ctx.coreLogger.debug('[egg-multipart:storeMultipart] handle stream part: %j', meta);
      // empty part, ignore it
      if (!part.filename) {
        await sendToWormhole(part);
        continue;
      }

      if (!storedir) {
        // ${tmpdir}/YYYY/MM/DD/HH
        storedir = path.join(ctx.app.config.multipart.tmpdir, moment().format('YYYY/MM/DD/HH'));
        const exists = await fs.exists(storedir);
        if (!exists) {
          await mkdirp(storedir);
        }
      }
      const filepath = path.join(storedir, uuid.v4() + path.extname(meta.filename));
      const target = fs.createWriteStream(filepath);
      await pump(part, target);
      // https://github.com/mscdex/busboy/blob/master/lib/types/multipart.js#L221
      meta.filepath = filepath;
      requestFiles.push(meta);

      // https://github.com/mscdex/busboy/blob/master/lib/types/multipart.js#L221
      if (part.truncated) {
        await ctx.cleanupRequestFiles(requestFiles);
        return await limit('Request_fileSize_limit', 'Reach fileSize limit');
      }
    } while (part != null);
    // 将文件挂载在ctx.request.body和ctx.request.files上
    ctx.request.body = requestBody;
    ctx.request.files = requestFiles;
  },

  /**
   * create multipart.parts instance, to get separated files.
   * @function Context#multipart
   * @param {Object} [options] - override default multipart configurations
   *  - {Boolean} options.autoFields
   *  - {String} options.defCharset
   *  - {Object} options.limits
   *  - {Function} options.checkFile
   * @return {Yieldable} parts
   */
  // 封装ctx.multipart
  multipart(options) {
    // multipart/form-data
    if (!this.is('multipart')) {
      this.throw(400, 'Content-Type must be multipart/*');
    }
    if (this[HAS_CONSUMED]) throw new TypeError('the multipart request can\'t be consumed twice');

    this[HAS_CONSUMED] = true;
    // 拿到app.js封装的multipartParseOptions
    const parseOptions = Object.assign({}, this.app.config.multipartParseOptions);
    options = options || {};
    if (typeof options.autoFields === 'boolean') parseOptions.autoFields = options.autoFields;
    if (options.defCharset) parseOptions.defCharset = options.defCharset;
    if (options.checkFile) parseOptions.checkFile = options.checkFile;
    // merge and create a new limits object
    if (options.limits) parseOptions.limits = Object.assign({}, parseOptions.limits, options.limits);
    // 基于co-busboy模块对内容进行解析
    return parse(this, parseOptions);
  },

  /**
   * get upload file stream
   * @example
   * ```js
   * const stream = await ctx.getFileStream();
   * // get other fields
   * console.log(stream.fields);
   * ```
   * @function Context#getFileStream
   * @param {Object} options
   *  - {Boolean} options.requireFile - required file submit, default is true
   *  - {String} options.defCharset
   *  - {Object} options.limits
   *  - {Function} options.checkFile
   * @return {ReadStream} stream
   * @since 1.0.0
   */
  async getFileStream(options) {
    options = options || {};
    const multipartOptions = {
      autoFields: true,
    };
    if (options.defCharset) multipartOptions.defCharset = options.defCharset;
    if (options.limits) multipartOptions.limits = options.limits;
    if (options.checkFile) multipartOptions.checkFile = options.checkFile;
    const parts = this.multipart(multipartOptions);
    let stream = await parts();

    if (options.requireFile !== false) {
      // stream not exists, treat as an exception
      if (!stream || !stream.filename) {
        this.throw(400, 'Can\'t found upload file');
      }
    }

    if (!stream) {
      stream = new EmptyStream();
    }
    stream.fields = parts.field;
    //监听了busboy模块的超出文件大小限制的事件。
    stream.once('limit', () => {
      const err = new Error('Request file too large');
      err.name = 'MultipartFileTooLargeError';
      err.status = 413;
      err.fields = stream.fields;
      err.filename = stream.filename;
      if (stream.listenerCount('error') > 0) {
        stream.emit('error', err);
        this.coreLogger.warn(err);
      } else {
        this.coreLogger.error(err);
        // ignore next error event
        stream.on('error', () => {});
      }
      // ignore all data
      stream.resume();
    });
    return stream;
  },
};
