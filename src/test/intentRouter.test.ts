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

  /**
   * "para" is the Portuguese preposition far more often than the imperative of
   * "parar". Treating it as a stop verb turned every "deploy para producao"
   * into a proposal to stop the application.
   */
  test('the preposition "para" is not read as the stop verb', () => {
    const deployPhrases = [
      'fazer deploy para producao',
      'deploy para a app "api"',
      'publicar para o ambiente de staging',
      'rodar deploy para o site',
    ];

    for (const prompt of deployPhrases) {
      const intent = routeIntent(prompt);
      assert.notStrictEqual(
        intent.kind,
        'lifecycle',
        `"${prompt}" nao pode virar acao de ciclo de vida (obtido: ${JSON.stringify(intent)})`
      );
      assert.strictEqual(intent.kind, 'deploy');
    }
  });

  test('stop verbs still work', () => {
    const stopPhrases = ['parar a app "api"', 'pare o banco "pg"', 'stop na app "api"'];
    for (const prompt of stopPhrases) {
      const intent = routeIntent(prompt);
      assert.strictEqual(intent.kind, 'lifecycle');
      assert.strictEqual(
        intent.kind === 'lifecycle' ? intent.action : undefined,
        'stop'
      );
    }
  });

  /** Substring matching turned "login" and "catalogo" into log requests. */
  test('words merely containing "log" are not log requests', () => {
    assert.notStrictEqual(routeIntent('quero fazer login').kind, 'logs');
    assert.notStrictEqual(routeIntent('abrir o catalogo').kind, 'logs');
    assert.strictEqual(routeIntent('logs da app "api"').kind, 'logs');
    assert.strictEqual(routeIntent('ver o log da app "api"').kind, 'logs');
  });

  /**
   * "saude" alone used to mean a connectivity check, swallowing questions about
   * a specific resource.
   */
  test('health check is distinguished from a resource health question', () => {
    assert.strictEqual(routeIntent('health check coolify').kind, 'health');
    assert.strictEqual(routeIntent('testar conectividade').kind, 'health');
    assert.strictEqual(routeIntent('qual a saude do banco "pg"').kind, 'status');
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
