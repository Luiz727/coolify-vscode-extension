# Coolify Deployments VSCode Extension

An extension that allows you to manage and trigger your Coolify application deployments directly from Visual Studio Code.

> **Note**: This is a community extension and is not officially associated with Coolify.

![Screenshot](https://i.imgur.com/gHOfUpC.png)

## Features

- View all your Coolify applications in VS Code
- Track deployment status of your applications
- Trigger new deployments directly from VS Code
- Start, stop, and restart applications from Command Palette
- Monitor active deployments in real-time
- List deployments and inspect deployment details from Command Palette
- Cancel in-progress deployments from Command Palette with confirmation
- Open deployment logs directly from Command Palette
- Use `@coolify` in Copilot Chat for MVP actions:
   - Configure server URL and API token
   - List applications and check status
   - Start deployments
   - Read latest deployment logs
   - Start, stop, and restart applications
   - Run quick health checks (connectivity + token validation)

### Chat Tools (Configure Tools)

This extension also contributes Coolify tools to Copilot Chat's **Configure Tools** UI. Enable the tools there to allow automatic tool usage by the chat model.

Available tools:

- `coolify-configure`
- `coolify-healthCheck`
- `coolify-listApplications`
- `coolify-getApplicationStatus`
- `coolify-startDeployment`
- `coolify-applicationLifecycle`
- `coolify-getDeploymentLogs`

When adding new features, they only appear in Configure Tools after you:

1. Register runtime tool logic in `src/tools/CoolifyTools.ts`.
2. Add tool metadata under `contributes.languageModelTools` in `package.json`.

## Prerequisites

Before using this extension, ensure you have:

1. A server with Coolify configured and running
2. Access to your Coolify dashboard
3. An API token from your Coolify dashboard

## Setup and Configuration

1. Install the extension from the VS Code marketplace
2. Configure the extension with:
   - Your Coolify server URL (HTTPS recommended)
   - Your Coolify API token

You can configure these settings by:

- Using the command palette (Ctrl/Cmd + Shift + P) and searching for "Coolify: Configure"
- Or by clicking on Coolify Deployments on the activity bar and clicking on the configure button

## Usage

1. After configuration, your Coolify applications will appear in the sidebar
2. Use the deploy button to trigger a new deployment
3. Monitor the deployment progress in real-time

## Release Notes

### 1.0.0

Initial release of VSCode Coolify Extension with the following features:

- View Coolify applications
- Track deployment status
- Trigger new deployments
- Configure and reconfigure extension settings
- Real-time deployment tracking

## For more information

- [Coolify Documentation](https://coolify.io/docs)
- [Visual Studio Code's Extension API](http://code.visualstudio.com/api)

## Security notes

- The extension uses HTTPS by default when you omit the protocol.
- Insecure HTTP connections are blocked by default.
- If you must use HTTP in a trusted local network, enable `coolify.allowInsecureHttp` in VS Code settings.
- Webview content is protected with CSP and nonce-based script policy.

## Documentation

- [Operational Guide](docs/OPERATIONAL_GUIDE.md) — supported/unsupported matrix, troubleshooting, and expanded security guidance.
