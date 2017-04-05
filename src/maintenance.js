let taskcluster = require('taskcluster-client');
let _ = require('lodash');
let slugid = require('slugid');
let assert = require('assert');
let Debug = require('debug');

let setPulseUser = async function({username, password, namespace, rabbitManager, cfg}) {
  await rabbitManager.createUser(username, password, cfg.app.userTags);

  await rabbitManager.setUserPermissions(
    username,
    cfg.app.virtualhost,
    cfg.app.userConfigPermission.replace(/{{namespace}}/, namespace),
    cfg.app.userWritePermission.replace(/{{namespace}}/, namespace),
    cfg.app.userReadPermission.replace(/{{namespace}}/, namespace),
  );
};

/*
 * Attempt to create a new namespace entry and associated Rabbit user.
 * If the requested namespace exists, update it with any user-supplied settings,
 * and return it.
 */
module.exports.claim = async function({Namespace, cfg, rabbitManager, namespace, contact, expires}) {
  let newNamespace;
  let created;

  try {
    newNamespace = await Namespace.create({
      namespace: namespace,
      username: namespace,
      password: slugid.v4(),
      created: new Date(),
      expires,
      rotationState:  '1',
      nextRotation: taskcluster.fromNow(cfg.app.namespaceRotationInterval),
      contact,
    });

    created = true;
  } catch (err) {
    if (err.code !== 'EntityAlreadyExists') {
      throw err;
    }

    created = false;

    // get the existing row
    newNamespace = await Namespace.load({namespace: namespace});

    // If this claim contains different information, update it accordingly
    if (!_.isEqual(
      {expires: newNamespace.expires, contact: newNamespace.contact},
      {expires, contact})) {
      await newNamespace.modify(entity => {
        entity.expires = expires;
        entity.contact = contact;
      });

      newNamespace = await Namespace.load({namespace: namespace});
    }
  }

  if (created) {
    // set up the first user as active,
    await setPulseUser({
      username: `${namespace}-1`,
      password: newNamespace.password,
      namespace, cfg, rabbitManager});
    // ..and the second user as inactive (empty string means no logins allowed)
    await setPulseUser({
      username: `${namespace}-2`,
      password: '',
      namespace, cfg, rabbitManager});
  }

  return newNamespace;
};

module.exports.expire = async function({Namespace, now}) {
  assert(now instanceof Date, 'now must be given as option');
  let count = 0;
  await Namespace.scan({
    expires: Namespace.op.lessThan(now),
  }, {
    limit:            250, // max number of concurrent delete operations
    handler:          (ns) => {
      count++;
      return ns.remove(true);
    },
  });
  return count;
};

module.exports.rotate = async function({Namespace, now, cfg, rabbitManager}) {
  let count = 0;
  let debug = Debug('rotate');

  await Namespace.scan({
    nextRotation: Namespace.op.lessThan(now),
  }, {
    limit:            250, // max number of concurrent modify operations
    handler:          async (ns) => {
      count++;
      debug(`rotating ${ns.namespace}`);
      let password = slugid.v4();
      let rotationState = ns.rotationState === '1' ? '2' : '1';

      // modify user in rabbitmq
      await setPulseUser({
        username: `${ns.namespace}-${rotationState}`,
        password,
        namespace: ns.namespace,
        cfg, rabbitManager});

      // modify ns in table
      await ns.modify((entity) => {
        entity.rotationState = rotationState;
        entity.nextRotation = taskcluster.fromNow(cfg.app.namespaceRotationInterval),
        entity.password = password;
      });
    },
  });
  return count;
};
