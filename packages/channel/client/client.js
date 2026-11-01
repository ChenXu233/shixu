/**
 * Browser half of dsh-shixu-channel: contributes the Shixu section to the
 * Settings panel.
 *
 * DSH's client module system runs this file only to register a lazy factory,
 * and hands that factory a `require` resolving the shared browser module table
 * (React comes from there). That is why this file is plain CommonJS: no JSX,
 * no bundler, and no React copy of its own.
 *
 * Visible text is translated through the client locale service
 * (`ctx.locale`, namespace `shixu`). The dictionary is inline because the
 * browser can only load `client.js` and `client.*.js` chunks from /plugins:
 * a package's `locale/*.json` is host-side package metadata and is not
 * reachable from a plugin bundle without a build step.
 *
 * Scope: the section renders a placeholder only. Reading and writing the
 * profile configuration is a later task, so nothing here touches
 * `ctx.remote.settings` yet.
 */
window.__ModuleLoader__.load({
  id: 'dsh-shixu-channel',
  factory: function factory(require) {
    var React = require('react');
    var h = React.createElement;

    /** Locale namespace owned by this plugin. */
    var LOCALE_NS = 'shixu';

    /**
     * Services this module cannot run without. `slots` owns the registration
     * seat, `locale` the dictionaries, `remote` and `remote.settings` the
     * settings transport the section will read and write through.
     */
    var inject = ['slots', 'locale', 'remote', 'remote.settings'];

    /**
     * Section copy, keyed by locale id. English terminates the fallback chain,
     * so it has to stay complete when other locales arrive.
     */
    var MESSAGES = {
      zh: {
        'section.label': '时煦',
        'section.placeholder': '配置面板',
      },
      en: {
        'section.label': 'Shixu',
        'section.placeholder': 'Configuration panel',
      },
    };

    /**
     * Only theme tokens: a renamed token degrades appearance, while a literal
     * colour would ignore the host's light and dark themes.
     */
    var styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '16px 0',
        color: 'var(--dsw-alias-label-primary)',
      },
      title: { fontSize: '14px', lineHeight: '22px', fontWeight: 500 },
      placeholder: {
        margin: 0,
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
    };

    /**
     * Build the section around one bound translate function, so the body
     * follows a locale switch without re-registering the slot entry.
     *
     * @param t - translate function bound to this plugin's namespace.
     * @returns the section component.
     */
    function createSection(t) {
      return function ShixuSettingsSection() {
        return h(
          'div',
          { style: styles.root },
          h('div', { style: styles.title }, t('section.label')),
          h('p', { style: styles.placeholder }, t('section.placeholder'))
        );
      };
    }

    /**
     * Register the dictionaries and the settings section once its slot
     * declaration is on the ledger.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(LOCALE_NS, MESSAGES);
      }, 'shixu: locale dictionaries');

      var t = ctx.locale.bind(LOCALE_NS);

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'shixu',
            order: 40,
            label: function () {
              return t('section.label');
            },
          },
          createSection(t)
        );
      });
    }

    return { inject: inject, apply: apply };
  },
});
