/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

require('babel-core/register');

var bl = require('bl');
var config = require('./package.json').config;
var express = require('express');
var fs = require('fs');
var mentionBot = require('./mention-bot.js');
var messageGenerator = require('./message.js');
var util = require('util');
var Q = require('q');
var GitHubApi = require('github');

var CONFIG_PATH = '.mention-bot';

if (!process.env.GITHUB_TOKEN) {
  console.error('The bot was started without a github account to post with.');
  console.error('To get started:');
  console.error('1) Create a new account for the bot');
  console.error('2) Settings > Personal access tokens > Generate new token');
  console.error('3) Only check `public_repo` and click Generate token');
  console.error('4) Run the following command:');
  console.error('GITHUB_TOKEN=insert_token_here npm start');
  console.error('5) Run the following command in another tab:');
  console.error('curl -X POST -d @__tests__/data/23.webhook http://localhost:5000/');
  console.error('6) Check that it commented here: https://github.com/fbsamples/bot-testing/pull/23');
  process.exit(1);
}

if (!process.env.GITHUB_USER) {
	console.warn(
		'There was no github user detected.',
		'This is fine, but mention-bot won\'t work with private repos.'
	);
	console.warn(
		'To make mention-bot work with private repos, please expose',
		'GITHUB_USER and GITHUB_PASSWORD as environment variables.',
		'The user and password must have access to the private repo',
		'you want to use.'
	);
}

var githubUsers = [];

var github = new GitHubApi({
  version: '3.0.0',
  host: config.gheHost,
  pathPrefix: config.ghePathPrefix
});

github.authenticate({
  type: 'oauth',
  token: process.env.GITHUB_TOKEN
});

var app = express();

function buildMentionSentence(reviewers) {
  var atReviewers = reviewers.map(function(owner) { return '@' + owner; });

  if (reviewers.length === 1) {
    return atReviewers[0];
  }

  return (
    atReviewers.slice(0, atReviewers.length - 1).join(', ') +
    ' and ' + atReviewers[atReviewers.length - 1]
  );
}

function defaultMessageGenerator(reviewers) {
  return util.format(
    'By analyzing the blame information on this pull request' +
     ', we identified %s to be%s potential reviewer%s',
     buildMentionSentence(reviewers),
     reviewers.length > 1 ? '' : ' a',
     reviewers.length > 1 ? 's' : ''
  );
};

app.post('/', function(req, res) {
  req.pipe(bl(function(err, body) {
    var data = {};
    try { data = JSON.parse(body.toString()); } catch (e) {}

    if (data.action !== 'opened' && data.action !== 'reopened') {
      console.log(
        'Skipping because action is ' + data.action + '.',
        'We only care about opened.'
      );
      return res.end();
    }

    // request config from repo
    github.repos.getContent({
      user: data.repository.owner.login,
      repo: data.repository.name,
      path: CONFIG_PATH,
      headers: {
        Accept: 'application/vnd.github.v3.raw'
      }
    }, function(err, configRes) {
      // default config
      var repoConfig = {
        userBlacklist: []
      };

      if (!err && configRes) {
        try { repoConfig = JSON.parse(configRes); } catch (e) {}
      }

      var reviewers = mentionBot.guessOwnersForPullRequest(
        data.repository.html_url, // 'https://github.com/fbsamples/bot-testing'
        data.pull_request.number, // 23
        data.pull_request.user.login, // 'mention-bot'
        data.pull_request.base.ref, // 'master'
        repoConfig
      );

      console.log(data.pull_request.html_url, reviewers);

      if (reviewers.length === 0) {
        console.log('Skipping because there are no reviewers found.');
        return res.end();
      }

      var promises = [];
      var activeReviewers = [];
      reviewers.forEach(function (reviewer) {
        var def = Q.defer();
        if (!githubUsers[reviewer]) {
          github.user.getFrom({'user': reviewer}, function(err, data) {
            if (err) {
              console.log(err);
            } else {
              if (data.suspended_at) {
                githubUsers[reviewer] = false;
              } else {
                githubUsers[reviewer] = true;
                activeReviewers.push(reviewer);
              }
            }
            def.resolve();
          });
        } else {
          console.log("accessing cache");
          if (githubUsers[reviewer]) {
            activeReviewers.push(reviewer);
          }
          def.resolve();
        }
        promises.push(def.promise);
      });

      Q.all(promises).then(function() {
	      github.issues.createComment({
		      user: data.repository.owner.login, // 'fbsamples'
		      repo: data.repository.name, // 'bot-testing'
		      number: data.pull_request.number, // 23
		      body: messageGenerator(
			      activeReviewers,
			      buildMentionSentence,
			      defaultMessageGenerator
		      )
	      });
      });

      return res.end();
    });
  }));
});

app.get('/', function(req, res) {
  res.send(
    'GitHub Mention Bot Active. ' +
    'Go to https://github.com/facebook/mention-bot for more information.'
  );
});

app.set('port', process.env.PORT || 5000);

app.listen(app.get('port'), function() {
  console.log('Listening on port', app.get('port'));
});
