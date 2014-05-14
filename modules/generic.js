module.exports = {
  "about": function(data, user, target) {
    this.client.say(target, "I'm a bot!");
    return user.nickname + " asked about me.";
  }
};