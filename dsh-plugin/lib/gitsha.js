/**
 * git 对象哈希：`sha1("blob <len>\0" + content)`。
 *
 * 单独成模块是因为它被两侧用到，而两侧彼此不该互相依赖：
 *   - `github.js` —— 校验下载内容与 tree API 给出的 blob sha 是否一致（网络侧）；
 *   - `backups.js` —— 算本地文件的快照，判断「有没有被人改过」（存储侧）。
 *
 * 两边用**同一个算法**才谈得上比对，所以定义只允许有一份。
 */

import { createHash } from 'node:crypto'

/** 一个 Buffer 的 git blob SHA-1。 */
export function gitBlobSha1(buffer) {
	return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

/** 文本内容的 git blob SHA-1。 */
export function gitBlobSha1OfText(text) {
	return gitBlobSha1(Buffer.from(text, 'utf8'))
}
