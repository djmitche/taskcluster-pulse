let APIBuilder = require('taskcluster-lib-api');
let assert = require('assert');
let debug = require('debug')('taskcluster-pulse');
let _ = require('lodash');
let maintenance = require('./maintenance');
let taskcluster = require('taskcluster-client');
let Entity = require('azure-entities');

let builder = new APIBuilder({
  title: 'Pulse Management Service',
  description: [
    'The taskcluster-pulse service, typically available at `pulse.taskcluster.net`',
    'manages pulse credentials for taskcluster users.',
    '',
    'A service to manage Pulse credentials for anything using',
    'Taskcluster credentials. This allows for self-service pulse',
    'access and greater control within the Taskcluster project.',
  ].join('\n'),
  serviceName: 'pulse',
  version: 'v1',
  params: {
    namespace: function(namespace) {
      if (namespace.length > 64 || !/^[A-Za-z0-9_-]+$/.test(namespace)) {
        return 'Invalid namespace provided.  Namespaces must be at most 64 bytes and contain only [A-Za-z-0-9_:-]';
      }
      const prefix = this.cfg.app.namespacePrefix;
      if (prefix && !namespace.startsWith(prefix)) {
        return `Invalid namespace provided.  Namespaces must begin with '${prefix}'`;
      }
      return false;
    },
  },
  context: [
    'cfg',
    'rabbitManager',
    'Namespace',
  ],
  errorCodes: {
    InvalidNamespace: 400,
  },
});

module.exports = builder;

builder.declare({
  method:         'get',
  route:          '/namespaces',
  name:           'listNamespaces',
  stability:      'experimental',
  output:         'list-namespaces-response.yml',
  title:          'List Namespaces',
  query: {
    limit: /[0-9]+/,
    continuationToken: Entity.continuationTokenPattern,
  },
  description: [
    'List the namespaces managed by this service.',
    '',
    'This will list up to 1000 namespaces. If more namespaces are present a',
    '`continuationToken` will be returned, which can be given in the next',
    'request. For the initial request, do not provide continuation token.',
  ].join('\n'),
}, async function(req, res) {
  var continuation = req.query.continuationToken;
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

builder.declare({
  method:   'get',
  route:    '/namespace/:namespace',
  name:     'namespace',
  title:    'Get a namespace',
  output:   'namespace.yml',
  stability: 'experimental',
  description: [
    'Get public information about a single namespace. This is the same information',
    'as returned by `listNamespaces`.',
  ].join('\n'),
}, async function(req, res) {
  let {namespace} = req.params;

  let ns = await this.Namespace.load({namespace}, true);
  if (!ns) {
    return res.reportError('ResourceNotFound', 'No such namespace', {});
  }
  res.reply(ns.json({cfg: this.cfg, includePassword: false}));
});

builder.declare({
  method:   'post',
  route:    '/namespace/:namespace',
  name:     'claimNamespace',
  title:    'Claim a namespace',
  input:    'namespace-request.yml',
  output:   'namespace-response.yml',
  scopes: {AllOf:
    ['pulse:namespace:<namespace>'],
  },
  stability: 'experimental',
  description: [
    'Claim a namespace, returning a connection string with access to that namespace',
    'good for use until the `reclaimAt` time in the response body. The connection',
    'string can be used as many times as desired during this period, but must not',
    'be used after `reclaimAt`.',
    '',
    'Connections made with this connection string may persist beyond `reclaimAt`,',
    'although it should not persist forever.  24 hours is a good maximum, and this',
    'service will terminate connections after 72 hours (although this value is',
    'configurable).',
    '',
    'The specified `expires` time updates any existing expiration times.  Connections',
    'for expired namespaces will be terminated.',
  ].join('\n'),
}, async function(req, res) {
  let {namespace} = req.params;

  // NOTE: at the moment we do not confirm that the user has permission to send
  // the given notification.  The possibility of abuse is remote (and would
  // involve abusing pulse), but we can solve this problem if and when we have
  // it.

  let expires = req.body.expires ? new Date(req.body.expires) : taskcluster.fromNow('4 hours');
  let contact = req.body.contact || '';
  let newNamespace = await maintenance.claim({
    Namespace: this.Namespace,
    cfg: this.cfg,
    rabbitManager: this.rabbitManager,
    namespace,
    contact,
    expires,
  });
  res.reply(newNamespace.json({cfg: this.cfg, includePassword: true}));
});
