let API = require('taskcluster-lib-api');
let assert = require('assert');
let debug = require('debug')('taskcluster-pulse');
let _ = require('lodash');
let maintenance = require('./maintenance');

let api = new API({
  title: 'Pulse Management Service',
  description: [
    'The taskcluster-pulse service, typically available at `pulse.taskcluster.net`',
    'manages pulse credentials for taskcluster users.',
    '',
    'A service to manage Pulse credentials for anything using',
    'Taskcluster credentials. This allows for self-service pulse',
    'access and greater control within the Taskcluster project.',
  ].join('\n'),
  schemaPrefix: 'http://schemas.taskcluster.net/pulse/v1/',
  context: [
    'cfg',
    'rabbitManager',
    'Namespace',
  ],
  errorCodes: {
    InvalidNamespace: 400,
  },
});

module.exports = api;

api.declare({
  method:     'get',
  route:      '/overview',
  name:       'overview',
  title:      'Rabbit Overview',
  output:     'rabbit-overview.json',
  stability:  'experimental',
  description: [
    'Get an overview of the Rabbit cluster.',
  ].join('\n'),
}, async function(req, res) {
  res.reply(
    _.pick(
      await this.rabbitManager.overview(),
      ['rabbitmq_version', 'cluster_name', 'management_version']
    )
  );
});

api.declare({
  method:     'get',
  route:      '/exchanges',
  name:       'exchanges',
  title:      'Rabbit Exchanges',
  output:     'exchanges-response.json',
  stability:  'experimental',
  description: [
    'Get a list of all exchanges in the rabbit cluster.  This will include exchanges',
    'not managed by this service, if any exist.',
  ].join('\n'),
}, async function(req, res) {
  res.reply(
    _.map(
      await this.rabbitManager.exchanges(),
      elem => _.pick(elem, ['name', 'vhost', 'type', 'durable', 'auto_delete', 'internal', 'arguments'])
    )
  );
});

api.declare({
  method:         'get',
  route:          '/namespaces',
  name:           'listNamespaces',
  stability:      'experimental',
  output:         'list-namespaces-response.json',
  title:          'List Namespaces',
  query: {
    limit: /[0-9]+/,
    continuation: /.*/,
  },
  description: [
    'List the namespaces managed by this service.',
    '',
    'This will list up to 1000 namespaces. If more namespaces are present a',
    '`continuationToken` will be returned, which can be given in the next',
    'request. For the initial request, do not provide continuation.',
  ].join('\n'),
}, async function(req, res) {
  var continuation = req.query.continuation;
  var limit = req.query.limit ? parseInt(req.query.limit, 10) : 1000;
  if (limit > 1000) {
    limit = 1000;
  }

  var retval = {};
  var data = await this.Namespace.scan({}, {limit, continuation});

  retval.namespaces = data.entries.map(ns =>
    ns.json({cfg: this.cfg, includePassword: false}));

  if (data.continuation) {
    retval.continuationToken = data.continuation;
  }

  return res.reply(retval);
});

api.declare({
  method:   'get',
  route:    '/namespace/:namespace',
  name:     'namespace',
  title:    'Get a namespace',
  output:   'namespace.json',
  stability: 'experimental',
  description: [
    'Get public information about a single namespace. This is the same information',
    'as returned by `listNamespaces`.',
  ].join('\n'),
}, async function(req, res) {
  let {namespace} = req.params;

  if (!isNamespaceValid(namespace, this.cfg)) {
    return invalidNamespaceResponse(req, res, this.cfg);
  }

  let ns = await this.Namespace.load({namespace}, true);
  if (!ns) {
    return res.reportError('ResourceNotFound', 'No such namespace', {});
  }
  res.reply(ns.json({cfg: this.cfg, includePassword: false}));
});

api.declare({
  method:   'post',
  route:    '/namespace/:namespace',
  name:     'claimNamespace',
  title:    'Claim a namespace',
  input:    'namespace-request.json',
  output:   'namespace-response.json',
  scopes:   [
    ['pulse:namespace:<namespace>'],
  ],
  stability: 'experimental',
  description: [
    'Claim a namespace, returning a username and password with access to that',
    'namespace good for a short time.  Clients should call this endpoint again',
    'at the re-claim time given in the response, as the password will be rotated',
    'soon after that time.  The namespace will expire, and any associated queues',
    'and exchanges will be deleted, at the given expiration time.',
    '',
    'The `expires` and `contact` properties can be updated at any time in a reclaim',
    'operation.',
  ].join('\n'),
}, async function(req, res) {
  let {namespace} = req.params;

  // NOTE: at the moment we do not confirm that the user has permission to send
  // the given notification.  The possibility of abuse is remote (and would
  // involve abusing pulse), but we can solve this problem if and when we have
  // it.

  if (!isNamespaceValid(namespace, this.cfg)) {
    return invalidNamespaceResponse(req, res, this.cfg);
  }

  let newNamespace = await maintenance.claim({
    Namespace: this.Namespace,
    cfg: this.cfg,
    rabbitManager: this.rabbitManager,
    namespace,
    contact: req.body.contact,
    expires: new Date(req.body.expires),
  });
  console.log(newNamespace.json({cfg: this.cfg, includePassword: true}));
  res.reply(newNamespace.json({cfg: this.cfg, includePassword: true}));
});

api.declare({
  method:   'delete',
  route:    '/namespace/:namespace',
  name:     'deleteNamespace',
  title:    'Delete a namespace',
  stability: 'experimental',
  scopes:   [
    ['pulse:namespace:<namespace>'],
  ],
  description: [
    'Immediately delete the given namespace.  This will delete all exchanges and queues which the',
    'namespace had configure access to, as if it had just expired.',
  ].join('\n'),
}, async function(req, res) {
  let {namespace} = req.params;

  if (!isNamespaceValid(namespace, this.cfg)) {
    return invalidNamespaceResponse(req, res, this.cfg);
  }

  let ns = await this.Namespace.load({namespace}, true);
  if (ns) {
    await maintenance.delete({
      Namespace: this.Namespace,
      rabbitManager: this.rabbitManager,
      cfg: this.cfg,
      namespace,
    });
  }

  res.reply({});
});

/**
 * Report an InvalidNamspeace error to the user
 */
function invalidNamespaceResponse(request, response, cfg) {
  let msg = ['Invalid namespace provided.  Namespaces must:'];
  msg.push('* be at most 64 bytes');
  msg.push('* contain only [A-Za-z-0-9_:-]');
  if (cfg.app.namespacePrefix) {
    msg.push(`* begin with "${cfg.app.namespacePrefix}"`);
  }
  return response.reportError('InvalidNamespace', msg.join('\n'), {});
}

/**
 * Check whether this is a valid namespace name, considering both hard-coded
 * limits and the configurable required prefix
 */
function isNamespaceValid(namespace, cfg) {
  if (namespace.length > 64 || !/^[A-Za-z0-9_-]+$/.test(namespace)) {
    return false;
  }
  const prefix = cfg.app.namespacePrefix;
  if (prefix && !namespace.startsWith(prefix)) {
    return false;
  }
  return true;
}
