import * as assert from 'assert';
import { extractTarget, routeIntent } from '../chat/intentRouter';

suite('Chat intent routing', () => {
  /**
   * Regression guard for the worst bug found in the audit: "listar deployments"
   * used to fall through to the deploy branch and, with a single application
   * registered, fire a real production deployment.
   */
  test('reading about deployments never routes to deploy', () => {
    const readingPrompts = [
      'listar deployments',
      'liste os deployments',
      'mostrar deployments da app "api"',
      'quais deployments existem',
      'deployments recentes',
      'listar deploys',
      'me mostre os últimos deployments',
    ];

    for (const prompt of readingPrompts) {
      const intent = routeIntent(prompt);
      assert.notStrictEqual(
        intent.kind,
        'deploy',
        `"${prompt}" nao pode disparar deploy (obtido: ${intent.kind})`
      );
      assert.strictEqual(
        intent.kind,
        'deployments',
        `"${prompt}" deveria consultar historico (obtido: ${intent.kind})`
      );
    }
  });

  test('explicit deploy verb still routes to deploy', () => {
    const deployPrompts = [
      'deploy da app "api"',
      'faça o deploy da aplicação "web"',
      'publicar a app "site"',
      'implantar a app "api"',
    ];

    for (const prompt of deployPrompts) {
      assert.strictEqual(
        routeIntent(prompt).kind,
        'deploy',
        `"${prompt}" deveria ser deploy`
      );
    }
  });

  test('list intents resolve the right resource kind', () => {
    assert.deepStrictEqual(routeIntent('listar apps'), {
      kind: 'list',
      resource: 'application',
    });
    assert.deepStrictEqual(routeIntent('listar serviços'), {
      kind: 'list',
      resource: 'service',
    });
    assert.deepStrictEqual(routeIntent('listar bancos'), {
      kind: 'list',
      resource: 'database',
    });
  });

  test('lifecycle intents carry action and resource', () => {
    assert.deepStrictEqual(routeIntent('restart da app "api"'), {
      kind: 'lifecycle',
      action: 'restart',
      resource: 'application',
    });
    assert.deepStrictEqual(routeIntent('parar o banco "pg"'), {
      kind: 'lifecycle',
      action: 'stop',
      resource: 'database',
    });
    assert.deepStrictEqual(routeIntent('iniciar o serviço "redis"'), {
      kind: 'lifecycle',
      action: 'start',
      resource: 'service',
    });
  });

  test('logs and status intents are recognised', () => {
    assert.strictEqual(routeIntent('logs da app "api"').kind, 'logs');
    assert.strictEqual(routeIntent('status da app "api"').kind, 'status');
    assert.strictEqual(routeIntent('health check coolify').kind, 'health');
    assert.strictEqual(routeIntent('listar servidores').kind, 'servers');
  });

  test('empty and unknown prompts fall back to help, never to an action', () => {
    assert.strictEqual(routeIntent('').kind, 'help');
    assert.strictEqual(routeIntent('   ').kind, 'help');
    assert.strictEqual(routeIntent('bom dia').kind, 'help');
    assert.strictEqual(routeIntent('obrigado'). kind, 'help');
  });

  test('extractTarget prefers quoted names', () => {
    assert.strictEqual(extractTarget('deploy da app "meu-app"'), 'meu-app');
    assert.strictEqual(extractTarget("restart do serviço 'redis-cache'"), 'redis-cache');
    assert.strictEqual(extractTarget('status da app api-prod'), 'api-prod');
    assert.strictEqual(extractTarget('listar apps'), undefined);
  });
});
