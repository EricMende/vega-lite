import {isNumber, isObject} from 'vega-util';
import {Channel} from '../channel';
import {Config} from '../config';
import {Encoding, extractTransformsFromEncoding, fieldDefs} from '../encoding';
import {PositionFieldDef, TextFieldDef} from '../fielddef';
import * as log from '../log';
import {isMarkDef, MarkDef} from '../mark';
import {GenericUnitSpec, NormalizedLayerSpec, NormalizedUnitSpec} from '../spec';
import {AggregatedFieldDef, CalculateTransform} from '../transform';
import {Flag, getFirstDefined, keys} from '../util';
import {Orient} from '../vega.schema';
import {
  compositeMarkContinuousAxis,
  compositeMarkOrient,
  filterUnsupportedChannels,
  GenericCompositeMarkDef,
  makeCompositeAggregatePartFactory,
  partLayerMixins,
  PartsMixins
} from './common';

export const BOXPLOT: 'boxplot' = 'boxplot';
export type BoxPlot = typeof BOXPLOT;

export type BoxPlotPart = 'box' | 'median' | 'outliers' | 'rule' | 'ticks';

const BOXPLOT_PART_INDEX: Flag<BoxPlotPart> = {
  box: 1,
  median: 1,
  outliers: 1,
  rule: 1,
  ticks: 1
};

export const BOXPLOT_PARTS = keys(BOXPLOT_PART_INDEX);

export type BoxPlotPartsMixins = PartsMixins<BoxPlotPart>;

export interface BoxPlotConfig extends BoxPlotPartsMixins {
  /** Size of the box and median tick of a box plot */
  size?: number;

  /**
   * The extent of the whiskers. Available options include:
   * - `"min-max"`: min and max are the lower and upper whiskers respectively.
   * - A number representing multiple of the interquartile range (Q3-Q1).  This number will be multiplied by the IQR. The product will be added to the third quartile to get the upper whisker and subtracted from the first quartile to get the lower whisker.
   *
   * __Default value:__ `1.5`.
   */
  extent?: 'min-max' | number;
}

export type BoxPlotDef = GenericCompositeMarkDef<BoxPlot> &
  BoxPlotConfig & {
    /**
     * Type of the mark.  For box plots, this should always be `"boxplot"`.
     * [boxplot](https://vega.github.io/vega-lite/docs/boxplot.html)
     */
    type: BoxPlot;

    /**
     * Orientation of the box plot.  This is normally automatically determined based on types of fields on x and y channels. However, an explicit `orient` be specified when the orientation is ambiguous.
     *
     * __Default value:__ `"vertical"`.
     */
    orient?: Orient;
  };

export interface BoxPlotConfigMixins {
  /**
   * Box Config
   */
  boxplot?: BoxPlotConfig;
}

const boxPlotSupportedChannels: Channel[] = ['x', 'y', 'color', 'detail', 'opacity', 'size'];

export function normalizeBoxPlot(
  spec: GenericUnitSpec<Encoding<string>, BoxPlot | BoxPlotDef>,
  config: Config
): NormalizedLayerSpec {
  spec = filterUnsupportedChannels(spec, boxPlotSupportedChannels, BOXPLOT);

  // TODO: use selection
  const {mark, encoding: _encoding, selection, projection: _p, ...outerSpec} = spec;
  const markDef: BoxPlotDef = isMarkDef(mark) ? mark : {type: mark};

  // TODO(https://github.com/vega/vega-lite/issues/3702): add selection support
  if (selection) {
    log.warn(log.message.selectionNotSupported('boxplot'));
  }

  const extent = markDef.extent || config.boxplot.extent;
  const sizeValue = getFirstDefined(markDef.size, config.boxplot.size);
  const isMinMax = !isNumber(extent);

  const {
    transform,
    continuousAxisChannelDef,
    continuousAxis,
    groupby,
    encodingWithoutContinuousAxis,
    tickOrient
  } = boxParams(spec, extent, config);

  const {color, size, ...encodingWithoutSizeColorAndContinuousAxis} = encodingWithoutContinuousAxis;

  const makeBoxPlotPart = (sharedEncoding: Encoding<string>) => {
    return makeCompositeAggregatePartFactory<BoxPlotPartsMixins>(
      markDef,
      continuousAxis,
      continuousAxisChannelDef,
      sharedEncoding,
      config.boxplot
    );
  };

  const makeBoxPlotExtent = makeBoxPlotPart(encodingWithoutSizeColorAndContinuousAxis);
  const makeBoxPlotBox = makeBoxPlotPart(encodingWithoutContinuousAxis);
  const makeBoxPlotMidTick = makeBoxPlotPart({...encodingWithoutSizeColorAndContinuousAxis, ...(size ? {size} : {})});

  const endTick: MarkDef = {type: 'tick', color: 'black', opacity: 1, orient: tickOrient};

  const bar: MarkDef = {type: 'bar', ...(sizeValue ? {size: sizeValue} : {})};

  const midTick: MarkDef = {
    type: 'tick',
    ...(isObject(config.boxplot.median) && config.boxplot.median.color ? {color: config.boxplot.median.color} : {}),
    ...(sizeValue ? {size: sizeValue} : {}),
    orient: tickOrient
  };

  const tooltip: TextFieldDef<string>[] = getTooltip(isMinMax, continuousAxisChannelDef, encodingWithoutContinuousAxis);
  const tooltipEncoding: Encoding<string> = {tooltip};

  // TODO: support hiding certain mark parts
  const boxLayer: NormalizedUnitSpec[] = [
    ...makeBoxPlotExtent('rule', 'rule', 'lower_whisker', 'lower_box', tooltipEncoding),
    ...makeBoxPlotExtent('rule', 'rule', 'upper_box', 'upper_whisker', tooltipEncoding),
    ...makeBoxPlotExtent('ticks', endTick, 'lower_whisker', null, tooltipEncoding),
    ...makeBoxPlotExtent('ticks', endTick, 'upper_whisker', null, tooltipEncoding),
    ...makeBoxPlotBox('box', bar, 'lower_box', 'upper_box', tooltipEncoding),
    ...makeBoxPlotMidTick('median', midTick, 'mid_box', null, tooltipEncoding)
  ];

  let outliersLayerMixins: NormalizedUnitSpec[] = [];

  if (!isMinMax) {
    const lowerBoxExpr: string = 'datum.lower_box_' + continuousAxisChannelDef.field;
    const upperBoxExpr: string = 'datum.upper_box_' + continuousAxisChannelDef.field;
    const iqrExpr = `(${upperBoxExpr} - ${lowerBoxExpr})`;
    const lowerWhiskerExpr = `${lowerBoxExpr} - ${extent} * ${iqrExpr}`;
    const upperWhiskerExpr = `${upperBoxExpr} + ${extent} * ${iqrExpr}`;
    const fieldExpr = `datum.${continuousAxisChannelDef.field}`;

    outliersLayerMixins = partLayerMixins<BoxPlotPartsMixins>(markDef, 'outliers', config.boxplot, {
      transform: [
        {
          window: boxParamsQuartiles(continuousAxisChannelDef.field),
          frame: [null, null],
          groupby
        },
        {
          filter: `(${fieldExpr} < ${lowerWhiskerExpr}) || (${fieldExpr} > ${upperWhiskerExpr})`
        }
      ],
      mark: 'point',
      encoding: {
        [continuousAxis]: {
          field: continuousAxisChannelDef.field,
          type: continuousAxisChannelDef.type
        },
        ...encodingWithoutSizeColorAndContinuousAxis
      }
    });
  }

  if (outliersLayerMixins.length > 0) {
    // tukey box plot with outliers included
    return {
      ...outerSpec,
      layer: [
        {
          // boxplot
          transform,
          layer: boxLayer
        },
        ...outliersLayerMixins
      ]
    };
  }
  return {
    ...outerSpec,
    transform: (outerSpec.transform || []).concat(transform),
    layer: boxLayer
  };
}

function getTooltip(
  isMinMax: boolean,
  continuousAxisChannelDef: PositionFieldDef<string>,
  encodingWithoutContinuousAxis: Encoding<string>
): TextFieldDef<string>[] {
  const fiveSummaryTooltip: TextFieldDef<string>[] = [
    {fieldPrefix: 'upper_whisker', titlePrefix: isMinMax ? 'Max' : 'Upper Whisker'},
    {fieldPrefix: 'upper_box', titlePrefix: 'Q3'},
    {fieldPrefix: 'mid_box', titlePrefix: 'Median'},
    {fieldPrefix: 'lower_box', titlePrefix: 'Q1'},
    {fieldPrefix: 'lower_whisker', titlePrefix: isMinMax ? 'Min' : 'Lower Whisker'}
  ].map(
    ({fieldPrefix, titlePrefix}): TextFieldDef<string> => ({
      field: fieldPrefix + '_' + continuousAxisChannelDef.field,
      type: continuousAxisChannelDef.type,
      title: titlePrefix + ' of ' + continuousAxisChannelDef.field
    })
  );

  return [
    ...fiveSummaryTooltip,
    // need to cast because TextFieldDef support fewer types of bin
    ...(fieldDefs(encodingWithoutContinuousAxis) as TextFieldDef<string>[])
  ];
}

function boxParamsQuartiles(continousAxisField: string): AggregatedFieldDef[] {
  return [
    {
      op: 'q1',
      field: continousAxisField,
      as: 'lower_box_' + continousAxisField
    },
    {
      op: 'q3',
      field: continousAxisField,
      as: 'upper_box_' + continousAxisField
    }
  ];
}

function boxParams(
  spec: GenericUnitSpec<Encoding<string>, BoxPlot | BoxPlotDef>,
  extent: 'min-max' | number,
  config: Config
) {
  const orient = compositeMarkOrient(spec, BOXPLOT);
  const {continuousAxisChannelDef, continuousAxis} = compositeMarkContinuousAxis(spec, orient, BOXPLOT);
  const continuousFieldName: string = continuousAxisChannelDef.field;

  const isMinMax = !isNumber(extent);
  const boxplotSpecificAggregate: AggregatedFieldDef[] = [
    ...boxParamsQuartiles(continuousFieldName),
    {
      op: 'median',
      field: continuousFieldName,
      as: 'mid_box_' + continuousFieldName
    },
    {
      op: 'min',
      field: continuousFieldName,
      as: (isMinMax ? 'lower_whisker_' : 'min_') + continuousFieldName
    },
    {
      op: 'max',
      field: continuousFieldName,
      as: (isMinMax ? 'upper_whisker_' : 'max_') + continuousFieldName
    }
  ];

  const postAggregateCalculates: CalculateTransform[] = isMinMax
    ? []
    : [
        {
          calculate: `datum.upper_box_${continuousFieldName} - datum.lower_box_${continuousFieldName}`,
          as: 'iqr_' + continuousFieldName
        },
        {
          calculate: `min(datum.upper_box_${continuousFieldName} + datum.iqr_${continuousFieldName} * ${extent}, datum.max_${continuousFieldName})`,
          as: 'upper_whisker_' + continuousFieldName
        },
        {
          calculate: `max(datum.lower_box_${continuousFieldName} - datum.iqr_${continuousFieldName} * ${extent}, datum.min_${continuousFieldName})`,
          as: 'lower_whisker_' + continuousFieldName
        }
      ];

  const {[continuousAxis]: oldContinuousAxisChannelDef, ...oldEncodingWithoutContinuousAxis} = spec.encoding;

  const {bins, timeUnits, aggregate, groupby, encoding: encodingWithoutContinuousAxis} = extractTransformsFromEncoding(
    oldEncodingWithoutContinuousAxis,
    config
  );

  const tickOrient: Orient = orient === 'vertical' ? 'horizontal' : 'vertical';

  return {
    transform: [
      ...bins,
      ...timeUnits,
      {
        aggregate: [...aggregate, ...boxplotSpecificAggregate],
        groupby
      },
      ...postAggregateCalculates
    ],
    groupby,
    continuousAxisChannelDef,
    continuousAxis,
    encodingWithoutContinuousAxis,
    tickOrient
  };
}
