/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { spawn, exec } from 'child_process';
import * as path from 'path';
import URI from 'vs/base/common/uri';

export interface ProcessItem {
	name: string;
	cmd: string;
	pid: number;
	ppid: number;
	load: number;
	mem: number;

	children?: ProcessItem[];
}

export function listProcesses(rootPid: number): Promise<ProcessItem> {

	return new Promise((resolve, reject) => {

		let rootItem: ProcessItem;
		const map = new Map<number, ProcessItem>();

		function addToTree(pid: number, ppid: number, cmd: string, load: number, mem: number) {

			const parent = map.get(ppid);
			if (pid === rootPid || parent) {

				const item: ProcessItem = {
					name: findName(cmd),
					cmd,
					pid,
					ppid,
					load,
					mem
				};
				map.set(pid, item);

				if (pid === rootPid) {
					rootItem = item;
				}

				if (parent) {
					if (!parent.children) {
						parent.children = [];
					}
					parent.children.push(item);
					if (parent.children.length > 1) {
						parent.children = parent.children.sort((a, b) => a.pid - b.pid);
					}
				}
			}
		}

		function findName(cmd: string): string {

			const RENDERER_PROCESS_HINT = /--disable-blink-features=Auxclick/;
			const WINDOWS_WATCHER_HINT = /\\watcher\\win32\\CodeHelper.exe/;
			const TYPE = /--type=([a-zA-Z-]+)/;

			// find windows file watcher
			if (WINDOWS_WATCHER_HINT.exec(cmd)) {
				return 'watcherService';
			}

			// find "--type=xxxx"
			let matches = TYPE.exec(cmd);
			if (matches && matches.length === 2) {
				if (matches[1] === 'renderer') {
					if (!RENDERER_PROCESS_HINT.exec(cmd)) {
						return 'shared-process';
					}

					return `window`;
				}
				return matches[1];
			}

			// find all xxxx.js
			const JS = /[a-zA-Z-]+\.js/g;
			let result = '';
			do {
				matches = JS.exec(cmd);
				if (matches) {
					result += matches + ' ';
				}
			} while (matches);

			if (result) {
				if (cmd.indexOf('node ') !== 0) {
					return `electron_node ${result}`;
				}
			}
			return cmd;
		}

		if (process.platform === 'win32') {

			interface ProcessInfo {
				type: 'processInfo';
				name: string;
				processId: number;
				parentProcessId: number;
				commandLine: string;
				handles: number;
				cpuLoad: number[];
				workingSetSize: number;
			}

			interface TopProcess {
				type: 'topProcess';
				name: string;
				processId: number;
				parentProcessId: number;
				commandLine: string;
				handles: number;
				cpuLoad: number[];
				workingSetSize: number;
			}

			type Item = ProcessInfo | TopProcess;

			const execMain = path.basename(process.execPath).replace(/ /g, '` ');
			const script = URI.parse(require.toUrl('vs/base/node/ps-win.ps1')).fsPath.replace(/ /g, '` ');
			const commandLine = `${script} -ProcessName ${execMain} -MaxSamples 3`;
			const cmd = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-Command', commandLine]);

			let stdout = '';
			let stderr = '';
			cmd.stdout.on('data', data => {
				stdout += data.toString();
			});

			cmd.stderr.on('data', data => {
				stderr += data.toString();
			});

			cmd.on('exit', () => {
				if (stderr.length > 0) {
					reject(stderr);
				}
				let processItems: Map<number, ProcessItem> = new Map();
				try {
					const items: Item[] = JSON.parse(stdout);
					for (const item of items) {
						if (item.type === 'processInfo') {
							let load = 0;
							if (item.cpuLoad) {
								for (let value of item.cpuLoad) {
									load += value;
								}
								load = load / item.cpuLoad.length;
							} else {
								load = -1;
							}
							processItems.set(item.processId, {
								name: findName(item.commandLine),
								cmd: item.commandLine,
								pid: item.processId,
								ppid: item.parentProcessId,
								load: load,
								mem: item.workingSetSize
							});
						}
					}
					rootItem = processItems.get(rootPid);
					if (rootItem) {
						processItems.forEach(item => {
							let parent = processItems.get(item.ppid);
							if (parent) {
								if (!parent.children) {
									parent.children = [];
								}
								parent.children.push(item);
							}
						});
						processItems.forEach(item => {
							if (item.children) {
								item.children = item.children.sort((a, b) => a.pid - b.pid);
							}
						});
						resolve(rootItem);
					} else {
						reject(new Error(`Root process ${rootPid} not found`));
					}
				} catch (error) {
					reject(error);
				}
			});
		} else {	// OS X & Linux

			const CMD = 'ps -ax -o pid=,ppid=,pcpu=,pmem=,command=';
			const PID_CMD = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+\.[0-9]+)\s+([0-9]+\.[0-9]+)\s+(.+)$/;

			exec(CMD, { maxBuffer: 1000 * 1024 }, (err, stdout, stderr) => {

				if (err || stderr) {
					reject(err || stderr.toString());
				} else {

					const lines = stdout.toString().split('\n');
					for (const line of lines) {
						let matches = PID_CMD.exec(line.trim());
						if (matches && matches.length === 6) {
							addToTree(parseInt(matches[1]), parseInt(matches[2]), matches[5], parseFloat(matches[3]), parseFloat(matches[4]));
						}
					}

					resolve(rootItem);
				}
			});
		}
	});
}
