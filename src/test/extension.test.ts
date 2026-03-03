import * as assert from 'assert';

import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('registers expected Coolify commands', async () => {
		const extension = vscode.extensions.getExtension('NixconSistemas.vscode-coolify');
		assert.ok(extension, 'Extension should be discoverable by identifier');
		await extension.activate();

		const commands = await vscode.commands.getCommands(true);

		const expectedCommands = [
			'coolify.configure',
			'coolify.reconfigure',
			'coolify.createContext',
			'coolify.switchContext',
			'coolify.deleteContext',
			'coolify.refreshApplications',
			'coolify.startDeployment',
			'coolify.startApplication',
			'coolify.stopApplication',
			'coolify.restartApplication',
			'coolify.selectLanguage',
			'coolify.setEnvSyncConflictStrategy',
			'coolify.showLogs',
			'coolify.listEnvironmentVariables',
			'coolify.createEnvironmentVariable',
			'coolify.updateEnvironmentVariable',
			'coolify.deleteEnvironmentVariable',
			'coolify.syncEnvironmentVariablesFromFile',
			'coolify.listDeployments',
			'coolify.showDeploymentDetails',
			'coolify.cancelDeployment',
			'coolify.showDeploymentLogs',
		];

		for (const command of expectedCommands) {
			assert.ok(
				commands.includes(command),
				`Expected command to be registered: ${command}`
			);
		}
	});

	test('contains webview contribution and configuration defaults', async () => {
		const extension = vscode.extensions.getExtension('NixconSistemas.vscode-coolify');
		assert.ok(extension, 'Extension should be discoverable by identifier');

		const packageJSON = extension.packageJSON as {
			contributes?: {
				views?: Record<string, Array<{ id: string; type?: string }>>;
				configuration?: {
					properties?: Record<string, { default?: unknown }>;
				};
			};
		};

		const coolifyViews = packageJSON.contributes?.views?.['coolify-sidebar'] || [];
		assert.ok(
			coolifyViews.some((view) => view.id === 'coolify-deployments'),
			'Expected coolify-deployments webview contribution'
		);

		const configProperties =
			packageJSON.contributes?.configuration?.properties || {};

		assert.strictEqual(
			configProperties['coolify.allowInsecureHttp']?.default,
			false
		);
		assert.strictEqual(configProperties['coolify.language']?.default, 'en');
		assert.strictEqual(
			configProperties['coolify.envSyncConflictStrategy']?.default,
			'prompt'
		);
	});
});
