var prefix = require('../config.json').cmdPrefix;

module.exports = {
  "about": function(data, user, target) {
    this.client.say(target, "I'm a bot that pulls NHL info for you.");
    return user.nickname + " asked about me.";
  },
  "source": function(data, user, target) {
    this.client.say(target, "If you have suggestions/feature requests or just want to see the source, it's at http://github.com/eugene-bulkin/node-hockey-bot");
    return user.nickname + " asked about my source.";
  },
  "help": function(data, user, target) {
    var cmds = Object.keys(this.help);
    var ds = data ? data.split(" ") : [];
    if(!this.isAdmin(user)) {
      cmds = cmds.filter(function(cmd) {
        return cmd[0] !== '~';
      });
    } else {
      cmds = cmds.map(function(cmd) {
        return cmd.replace('~', '');
      });
    }
    if(ds.length === 0) {
      this.client.say(target, user.nickname + ": " + "The following commands are available: " + cmds.join(", "));
      return "Read help to " + user.nickname;
    }
    if(this.help[ds[0]]) {
      this.client.say(target, "Help for " + prefix + ds[0] + ": " + this.help[ds[0]]);
      return "Read help to " + user.nickname + " for " + ds[0];
    }
    if(this.help["~" + ds[0]]) {
      this.client.say(target, "Help for " + prefix + ds[0] + ": " + this.help["~" + ds[0]]);
      return "Read help to " + user.nickname + " for " + ds[0];
    }
    this.client.say(target, user.nickname + ": " + "There is no help available for '" + ds[0] + "'.");
    return "Told " + user.nickname + " the '" + ds[0] + "' command does not exist";
  }
};